import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * プロジェクト ID: git remote origin URL の SHA-256 先頭12桁。
 * remote がない場合は cwd 絶対パスのハッシュにフォールバック（spec §3）。
 */
export function projectId(cwd: string): string {
  let source: string;
  try {
    source = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (source === "") throw new Error("empty remote");
  } catch {
    source = resolve(cwd);
  }
  return createHash("sha256").update(source).digest("hex").slice(0, 12);
}
