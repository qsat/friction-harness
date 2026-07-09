import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectId } from "../lib/project-id.ts";
import { inputHash } from "../lib/transcript.ts";
import { HARNESS_ROOT, runHook, projectFixture, tmpDir } from "./helpers.ts";

const HOOK = join(HARNESS_ROOT, "10-collect", "log-skill-use.ts");

function stdinFor(cwd: string, skill: string, toolUseId: string | null = "toolu_T1") {
  return JSON.stringify({
    session_id: "sess-1",
    transcript_path: "/tmp/t.jsonl",
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: "Skill",
    tool_input: { skill },
    tool_response: { success: true },
    tool_use_id: toolUseId,
  });
}

function readInvocations(home: string, cwd: string): any[] {
  const path = join(home, ".claude", "friction-data", projectId(cwd), "invocations.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").map((r) => JSON.parse(r));
}

describe("log-skill-use hook", () => {
  it("allowlist 登録スキルの発動を全フィールド付きで記録する", () => {
    const home = tmpDir("home");
    const cwd = projectFixture({ allowlist: ["my-skill"], skills: { "my-skill": "# skill\n" } });
    const r = runHook(HOOK, stdinFor(cwd, "my-skill"), { HOME: home });
    expect(r.exitCode).toBe(0);
    const rows = readInvocations(home, cwd);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      session_id: "sess-1",
      tool_use_id: "toolu_T1",
      skill_slug: "my-skill",
      input_hash: inputHash({ skill: "my-skill" }),
      transcript_path: "/tmp/t.jsonl",
      project_id: projectId(cwd),
    });
    expect(rows[0].skill_content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(rows[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("tool_use_id が null でも記録される（input_hash フォールバック用）", () => {
    const home = tmpDir("home");
    const cwd = projectFixture({ allowlist: ["my-skill"] });
    runHook(HOOK, stdinFor(cwd, "my-skill", null), { HOME: home });
    const rows = readInvocations(home, cwd);
    expect(rows[0].tool_use_id).toBeNull();
    expect(rows[0].skill_content_hash).toBeNull(); // SKILL.md 実体なし
  });

  it("allowlist 未登録スキルは記録しない", () => {
    const home = tmpDir("home");
    const cwd = projectFixture({ allowlist: ["other-skill"] });
    const r = runHook(HOOK, stdinFor(cwd, "my-skill"), { HOME: home });
    expect(r.exitCode).toBe(0);
    expect(readInvocations(home, cwd).length).toBe(0);
  });

  it("allowlist ファイルが無ければ記録しない（明示 opt-in）", () => {
    const home = tmpDir("home");
    const cwd = projectFixture({ allowlist: null });
    const r = runHook(HOOK, stdinFor(cwd, "my-skill"), { HOME: home });
    expect(r.exitCode).toBe(0);
    expect(readInvocations(home, cwd).length).toBe(0);
  });

  it("Skill 以外のツールは無視する", () => {
    const home = tmpDir("home");
    const cwd = projectFixture({ allowlist: ["my-skill"] });
    const stdin = JSON.stringify({ tool_name: "Write", tool_input: { skill: "my-skill" }, cwd });
    runHook(HOOK, stdin, { HOME: home });
    expect(readInvocations(home, cwd).length).toBe(0);
  });

  it("壊れた stdin でも exit 0（セッションを止めない）", () => {
    const r = runHook(HOOK, "garbage{{{", { HOME: tmpDir("home") });
    expect(r.exitCode).toBe(0);
  });
});
