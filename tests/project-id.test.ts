import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { projectId } from "../lib/project-id.ts";
import { tmpDir } from "./helpers.ts";

function sha12(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

describe("projectId", () => {
  it("git remote origin の URL ハッシュ先頭12桁（マシン間で安定）", () => {
    const dir = tmpDir("git");
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://example.com/o/r.git"]);
    expect(projectId(dir)).toBe(sha12("https://example.com/o/r.git"));
  });

  it("remote がなければ cwd 絶対パスのハッシュにフォールバック", () => {
    const dir = tmpDir("plain");
    expect(projectId(dir)).toBe(sha12(dir));
  });
});
