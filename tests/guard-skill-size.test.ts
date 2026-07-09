import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_ROOT, runHook, tmpDir } from "./helpers.ts";

const HOOK = join(HARNESS_ROOT, "10-collect", "guard-skill-size.ts");

function skillMdWithLines(n: number): string {
  const dir = join(tmpDir("guard"), "skills", "big-skill");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  return path;
}

function stdinFor(filePath: string): string {
  return JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath } });
}

describe("guard-skill-size hook", () => {
  it("500 行超過はブロック（exit 2 + supersede を促す stderr）", () => {
    const r = runHook(HOOK, stdinFor(skillMdWithLines(501)));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("行数バジェット超過");
    expect(r.stderr).toContain("supersede");
  });

  it("200〜500 行は非ブロックの警告（exit 0）", () => {
    const r = runHook(HOOK, stdinFor(skillMdWithLines(300)));
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("警告");
  });

  it("200 行以下は沈黙（exit 0）", () => {
    const r = runHook(HOOK, stdinFor(skillMdWithLines(200)));
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("skills/*/SKILL.md 以外のパスは対象外", () => {
    const dir = tmpDir("other");
    const path = join(dir, "SKILL.md"); // skills/ 配下ではない
    writeFileSync(path, Array.from({ length: 600 }, () => "x").join("\n"));
    const r = runHook(HOOK, stdinFor(path));
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("壊れた stdin でも exit 0", () => {
    const r = runHook(HOOK, "not json");
    expect(r.exitCode).toBe(0);
  });
});
