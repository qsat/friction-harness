/**
 * promote.ts のテスト。LLM は偽 claude でモック。
 * 重要な保証: promote は taxonomy/aliases を含む一切のファイルを書き換えない（spec §2-4）。
 */
import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { HARNESS_ROOT, tmpDir, writeJsonl } from "./helpers.ts";

const PROMOTE = join(HARNESS_ROOT, "40-promote", "promote.ts");

/** 偽 claude: 呼ばれたことを LOG に記録し、固定の提案（有効2 + 不正2）を返す */
function installFakeClaude(binDir: string, logPath: string): void {
  mkdirSync(binDir, { recursive: true });
  const script = `#!/usr/bin/env bun
await Bun.stdin.text();
const { appendFileSync } = await import("node:fs");
appendFileSync(${JSON.stringify(logPath)}, "called\\n");
console.log(JSON.stringify([
  { action: "promote", slug: "context-overflow", description: "コンテキスト超過起因の失敗",
    merge_from: ["context-window-exceeded"], rationale: "既存 type にマップ不能" },
  { action: "alias", to: "ambiguous-instruction",
    merge_from: ["unclear-wording"], rationale: "既存 type と同義" },
  { action: "promote", slug: "execution-friction", description: "既存と衝突",
    merge_from: ["context-window-exceeded"], rationale: "衝突テスト" },
  { action: "alias", to: "no-such-type",
    merge_from: ["unclear-wording"], rationale: "不正ターゲット" },
]));
`;
  const path = join(binDir, "claude");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function issueRow(candidate: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `iss-${candidate}-${i}`,
    session_id: `s${i}`,
    anchor_uuid: "a",
    skill_slug: "sk",
    issue_type: "other",
    issue_type_candidate: candidate,
    detail: `detail of ${candidate} ${i}`,
    severity: "low",
    taxonomy_version: "v0",
    evaluator_version: "v0",
    offset_range: [i, i + 1],
    extracted_at: "2026-07-09T00:00:00Z",
  }));
}

function runPromote(dataDir: string, env: Record<string, string>, extra: string[] = []) {
  const res = Bun.spawnSync(
    ["bun", PROMOTE, "--data-dir", dataDir, "--project-id", "test", ...extra],
    { env: { ...process.env, ...env }, cwd: HARNESS_ROOT },
  );
  return { exitCode: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

describe("promote", () => {
  it("閾値未満なら LLM を呼ばず現状を報告する", () => {
    const dataDir = tmpDir("promote");
    const logPath = join(tmpDir("log"), "calls.log");
    const binDir = join(tmpDir("bin"), "bin");
    installFakeClaude(binDir, logPath);
    writeJsonl(join(dataDir, "issues.jsonl"), issueRow("rare-candidate", 4)); // < 5
    const r = runPromote(dataDir, { PATH: binDir + delimiter + process.env.PATH! });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("達した candidate はない");
    expect(existsSync(logPath)).toBe(false); // LLM 未呼び出し
  });

  it("閾値以上で提案を出力し、不正提案は破棄、ファイルは一切書き換えない", () => {
    const dataDir = tmpDir("promote");
    const logPath = join(tmpDir("log"), "calls.log");
    const binDir = join(tmpDir("bin"), "bin");
    installFakeClaude(binDir, logPath);
    writeJsonl(join(dataDir, "issues.jsonl"), [
      ...issueRow("context-window-exceeded", 6),
      ...issueRow("unclear-wording", 5),
    ]);
    const taxPath = join(HARNESS_ROOT, "taxonomy", "taxonomy.yaml");
    const aliPath = join(HARNESS_ROOT, "taxonomy", "aliases.yaml");
    const taxBefore = readFileSync(taxPath, "utf8");
    const aliBefore = readFileSync(aliPath, "utf8");

    const r = runPromote(dataDir, { PATH: binDir + delimiter + process.env.PATH! }, ["--json"]);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(logPath, "utf8")).toBe("called\n"); // LLM は 1 回だけ

    const out = JSON.parse(r.stdout);
    expect(out.eligible.map((e: any) => e.candidate).sort()).toEqual([
      "context-window-exceeded",
      "unclear-wording",
    ]);
    // 有効提案 2 件（promote + alias）。既存 slug 衝突と不正ターゲットは破棄
    expect(out.proposals.length).toBe(2);
    const promote = out.proposals.find((p: any) => p.proposal.action === "promote");
    expect(promote.taxonomy_snippet).toContain("slug: context-overflow");
    expect(promote.taxonomy_snippet).toContain("status: provisional");
    expect(promote.aliases_snippet).toContain("from: context-window-exceeded, to: context-overflow");
    const alias = out.proposals.find((p: any) => p.proposal.action === "alias");
    expect(alias.taxonomy_snippet).toBeNull();
    expect(alias.aliases_snippet).toContain("from: unclear-wording, to: ambiguous-instruction");
    expect(r.stderr).toContain("slug collides with existing type: execution-friction");
    expect(r.stderr).toContain("alias target must be an existing type: no-such-type");

    // 提案止まり: taxonomy/aliases は不変（spec §2-4）
    expect(readFileSync(taxPath, "utf8")).toBe(taxBefore);
    expect(readFileSync(aliPath, "utf8")).toBe(aliBefore);
  });

  it("alias 済み candidate は昇格対象から除外される", () => {
    // 既定 aliases.yaml は空リストなので、ここでは taxonomy 既存 type と同名の
    // candidate（= 解決済み扱い）で除外を確認する
    const dataDir = tmpDir("promote");
    writeJsonl(join(dataDir, "issues.jsonl"), issueRow("execution-friction", 6));
    const r = runPromote(dataDir, {});
    expect(r.stdout).toContain("達した candidate はない");
  });
});
