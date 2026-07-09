/**
 * evaluate.ts の統合テスト。LLM は PATH 先頭に置いた偽 `claude` 実行ファイルで
 * モックする（決定論的な JSON を返す）。実 API は呼ばない。
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { inputHash } from "../lib/transcript.ts";
import { HARNESS_ROOT, tmpDir, writeJsonl, transcriptFixture } from "./helpers.ts";

const EVALUATE = join(HARNESS_ROOT, "20-evaluate", "evaluate.ts");

/**
 * 偽 claude: プロンプト中のマーカーから anchor uuid を拾い、
 * 有効 1 件 + 不正 3 件（未知 type / マーカー外 anchor / 非 slug candidate）を返す。
 * バリデーションが不正を落とすことまで一度に検証できる。
 */
function installFakeClaude(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const script = `#!/usr/bin/env bun
const text = await Bun.stdin.text();
const anchors = [...text.matchAll(/anchor=([0-9a-zA-Z_-]+)\\]/g)].map((m) => m[1]);
const a = anchors[0] ?? "none";
console.log(JSON.stringify([
  { anchor_uuid: a, issue_type: "missing-instruction", issue_type_candidate: null, detail: "手順が欠落", severity: "mid" },
  { anchor_uuid: a, issue_type: "bogus-type", issue_type_candidate: null, detail: "x", severity: "low" },
  { anchor_uuid: "not-a-marker-uuid", issue_type: "missing-instruction", issue_type_candidate: null, detail: "y", severity: "low" },
  { anchor_uuid: a, issue_type: "other", issue_type_candidate: "Bad Slug!", detail: "z", severity: "low" },
]));
`;
  const path = join(binDir, "claude");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

interface Fixture {
  dataDir: string;
  transcriptPath: string;
  anchorUuid: string;
  env: Record<string, string>;
}

function setup(): Fixture {
  const dataDir = tmpDir("data");
  const { lines, anchorUuid } = transcriptFixture({
    sessionId: "sess-e2e",
    toolUseId: "toolu_E2E",
    skill: "test-skill",
  });
  const transcriptPath = join(tmpDir("transcript"), "sess-e2e.jsonl");
  writeJsonl(transcriptPath, lines);
  writeJsonl(join(dataDir, "invocations.jsonl"), [
    {
      ts: "2026-07-09T00:00:01Z",
      session_id: "sess-e2e",
      tool_use_id: "toolu_E2E",
      skill_slug: "test-skill",
      input_hash: inputHash({ skill: "test-skill" }),
      skill_content_hash: "sha256:abc",
      transcript_path: transcriptPath,
      project_id: "testpid",
    },
  ]);
  const binDir = join(tmpDir("bin"), "bin");
  installFakeClaude(binDir);
  return {
    dataDir,
    transcriptPath,
    anchorUuid,
    env: { ...process.env, PATH: binDir + delimiter + process.env.PATH } as Record<string, string>,
  };
}

function runEvaluate(fx: Fixture, extra: string[] = []) {
  const res = Bun.spawnSync(["bun", EVALUATE, "--data-dir", fx.dataDir, ...extra], {
    env: fx.env,
    cwd: HARNESS_ROOT,
  });
  return { exitCode: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

function readIssues(dataDir: string): any[] {
  const path = join(dataDir, "issues.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((r) => JSON.parse(r));
}

describe("evaluate --dry-run（アンカー解決とウィンドウ区切り）", () => {
  it("マーカー入りウィンドウを出力し、ledger は進めない", () => {
    const fx = setup();
    const r = runEvaluate(fx, ["--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`[SKILL: test-skill invoked, anchor=${fx.anchorUuid}]`);
    expect(r.stdout).toContain("[skill-friction] test-skill");
    expect(r.stdout).toContain("agent_type=main");
    expect(existsSync(join(fx.dataDir, "ledger.jsonl"))).toBe(false);
  });
});

describe("evaluate 本実行（偽 claude で LLM モック）", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setup();
  });

  it("有効レコードのみ issues.jsonl に書き、不正はバリデーションで破棄する", () => {
    const r = runEvaluate(fx);
    expect(r.exitCode).toBe(0);
    const issues = readIssues(fx.dataDir);
    expect(issues.length).toBe(1); // 偽 claude は 4 件返すが有効は 1 件
    expect(issues[0]).toMatchObject({
      session_id: "sess-e2e",
      anchor_uuid: fx.anchorUuid,
      skill_slug: "test-skill",
      issue_type: "missing-instruction",
      severity: "mid",
      taxonomy_version: "v0",
    });
    expect(issues[0].id).toMatch(/^iss-[0-9A-Z]{26}$/);
    expect(issues[0].offset_range.length).toBe(2);
    // 破棄理由がログに残る（spec §5.4 手順 6）
    expect(r.stderr).toContain("unknown issue_type: bogus-type");
    expect(r.stderr).toContain("anchor_uuid not in marker set");
    expect(r.stderr).toContain("slug-form candidate");
  });

  it("ledger が進み、再実行では何もしない", () => {
    runEvaluate(fx);
    const ledger1 = readFileSync(join(fx.dataDir, "ledger.jsonl"), "utf8");
    runEvaluate(fx);
    expect(readFileSync(join(fx.dataDir, "ledger.jsonl"), "utf8")).toBe(ledger1);
    expect(readIssues(fx.dataDir).length).toBe(1);
  });

  it("冪等: カーソルを巻き戻して二重処理しても issues は重複しない", () => {
    runEvaluate(fx);
    // 再スキャンを模擬（processed_lines: 0 の台帳行を追記）
    appendFileSync(
      join(fx.dataDir, "ledger.jsonl"),
      JSON.stringify({
        session_id: "sess-e2e",
        transcript_path: fx.transcriptPath,
        processed_lines: 0,
        last_run: "reset",
      }) + "\n",
    );
    runEvaluate(fx);
    expect(readIssues(fx.dataDir).length).toBe(1); // (session_id, offset_range) キーで排除
  });

  it("--session で対象セッションを絞れる", () => {
    const r = runEvaluate(fx, ["--session", "no-such-session"]);
    expect(r.exitCode).toBe(0);
    expect(readIssues(fx.dataDir).length).toBe(0);
  });
});
