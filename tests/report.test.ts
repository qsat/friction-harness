/**
 * report.ts のテスト: 3 本の追記ログのみからの状態導出（spec §2-5, §5.6）と
 * alias の読み取り時適用（spec §2-1）を検証する。
 */
import { describe, expect, it } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_ROOT, tmpDir, writeJsonl } from "./helpers.ts";

const REPORT = join(HARNESS_ROOT, "30-report", "report.ts");

function runReport(dataDir: string, extra: string[] = []): any {
  const res = Bun.spawnSync(
    ["bun", REPORT, "--data-dir", dataDir, "--project-id", "test", "--json", ...extra],
    { cwd: HARNESS_ROOT },
  );
  expect(res.exitCode).toBe(0);
  return JSON.parse(res.stdout.toString());
}

function issue(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "iss-1",
    session_id: "s1",
    anchor_uuid: "a1",
    skill_slug: "my-skill",
    issue_type: "execution-friction",
    issue_type_candidate: null,
    detail: "d",
    severity: "high",
    taxonomy_version: "v0",
    evaluator_version: "v0",
    offset_range: [0, 10],
    extracted_at: "2026-07-09T00:00:00Z",
    ...over,
  };
}

function invocation(over: Partial<Record<string, unknown>> = {}) {
  return {
    ts: "2026-07-09T00:00:00Z",
    session_id: "s1",
    tool_use_id: null,
    skill_slug: "my-skill",
    input_hash: "sha256:x",
    skill_content_hash: "sha256:v1",
    transcript_path: "/t",
    project_id: "test",
    ...over,
  };
}

describe("report 導出ビュー", () => {
  it("open issues = issues − resolutions、severity high 1 件で改訂候補入り", () => {
    const dir = tmpDir("rep");
    writeJsonl(join(dir, "invocations.jsonl"), [invocation()]);
    writeJsonl(join(dir, "issues.jsonl"), [issue()]);
    const rep = runReport(dir);
    expect(rep.totals.open_issues).toBe(1);
    expect(rep.revision_candidates.map((r: any) => r.group_key)).toContain(
      "my-skill/execution-friction",
    );
    expect(rep.cross_tab["execution-friction"]["my-skill"]).toBe(1);
  });

  it("同一グループ open 3 件（low でも）で改訂候補入り", () => {
    const dir = tmpDir("rep");
    writeJsonl(join(dir, "invocations.jsonl"), [invocation()]);
    writeJsonl(
      join(dir, "issues.jsonl"),
      [1, 2, 3].map((i) => issue({ id: `iss-${i}`, severity: "low" })),
    );
    const rep = runReport(dir);
    expect(rep.revision_candidates[0].open_count).toBe(3);
  });

  it("resolution → verifying → verified → reopened をログのみから導出する", () => {
    const dir = tmpDir("rep");
    writeJsonl(join(dir, "invocations.jsonl"), [invocation()]);
    writeJsonl(join(dir, "issues.jsonl"), [issue()]);
    writeJsonl(join(dir, "resolutions.jsonl"), [
      {
        id: "res-1",
        group_key: "my-skill/execution-friction",
        issue_ids: ["iss-1"],
        action: "supersede",
        skill_commit: "abc",
        skill_content_hash_after: "sha256:v2",
        note: "n",
        resolved_at: "2026-07-09T01:00:00Z",
      },
    ]);

    // 1) 改訂後の発動ゼロ → verifying
    let rep = runReport(dir);
    expect(rep.totals.open_issues).toBe(0); // resolution で closed
    expect(rep.verification[0].status).toContain("verifying 0/5");

    // 2) 改訂後ハッシュで 5 発動・再発ゼロ → verified
    for (let i = 1; i <= 5; i++) {
      appendFileSync(
        join(dir, "invocations.jsonl"),
        JSON.stringify(invocation({ session_id: `after-${i}`, skill_content_hash: "sha256:v2" })) + "\n",
      );
    }
    rep = runReport(dir);
    expect(rep.verification[0].status).toBe("verified");

    // 3) 改訂後セッションで同一グループ再発 → reopened + 改訂候補へ復帰
    appendFileSync(
      join(dir, "issues.jsonl"),
      JSON.stringify(issue({ id: "iss-recur", session_id: "after-3", severity: "mid" })) + "\n",
    );
    rep = runReport(dir);
    expect(rep.verification[0].status).toBe("reopened");
    expect(rep.revision_candidates.map((r: any) => r.group_key)).toContain(
      "my-skill/execution-friction",
    );
  });

  it("wontfix の resolution は open を閉じるが検証対象にならない", () => {
    const dir = tmpDir("rep");
    writeJsonl(join(dir, "invocations.jsonl"), [invocation()]);
    writeJsonl(join(dir, "issues.jsonl"), [issue()]);
    writeJsonl(join(dir, "resolutions.jsonl"), [
      {
        id: "res-1",
        group_key: "my-skill/execution-friction",
        issue_ids: ["iss-1"],
        action: "wontfix",
        skill_commit: null,
        skill_content_hash_after: null,
        note: "エージェント側の誤読",
        resolved_at: "2026-07-09T01:00:00Z",
      },
    ]);
    const rep = runReport(dir);
    expect(rep.totals.open_issues).toBe(0);
    expect(rep.verification.length).toBe(0);
  });

  it("alias は読み取り時にのみ適用される（candidate → 正規 type、other 率から除外）", () => {
    const dir = tmpDir("rep");
    // taxonomy はコピー、aliases に candidate → 正規 type の写像を置く
    const taxDir = tmpDir("tax");
    copyFileSync(join(HARNESS_ROOT, "taxonomy", "taxonomy.yaml"), join(taxDir, "taxonomy.yaml"));
    writeFileSync(
      join(taxDir, "aliases.yaml"),
      "- {from: unclear-phase-boundary, to: ambiguous-instruction, added: 2026-07-09}\n",
    );
    writeJsonl(join(dir, "invocations.jsonl"), [invocation()]);
    writeJsonl(join(dir, "issues.jsonl"), [
      issue({ id: "iss-a", issue_type: "other", issue_type_candidate: "unclear-phase-boundary" }),
      issue({ id: "iss-b", issue_type: "other", issue_type_candidate: "brand-new-candidate", severity: "low" }),
    ]);
    const rep = runReport(dir, ["--taxonomy-dir", taxDir]);
    // alias 解決済み candidate は正規 type として集計され、other 率に入らない
    expect(rep.cross_tab["ambiguous-instruction"]["my-skill"]).toBe(1);
    // 未昇格 candidate は other 扱い（2 件中 1 件 = 0.5）
    expect(rep.other_rate).toBe(0.5);
    expect(rep.top_candidates).toEqual([["brand-new-candidate", 1]]);
  });

  it("健全率: 発動あり・issue ゼロの割合", () => {
    const dir = tmpDir("rep");
    writeJsonl(join(dir, "invocations.jsonl"), [
      invocation({ session_id: "s1" }),
      invocation({ session_id: "s2" }), // issue なし
    ]);
    writeJsonl(join(dir, "issues.jsonl"), [issue({ session_id: "s1" })]);
    const rep = runReport(dir);
    expect(rep.healthy_rate).toBe(0.5);
  });
});
