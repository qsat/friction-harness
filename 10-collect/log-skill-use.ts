#!/usr/bin/env bun
/**
 * L1: スキル発動記録（PostToolUse, matcher: Skill）。spec §5.1
 * 記録失敗でセッションを止めないため、いかなる経路でも exit 0 で終える。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { projectId } from "../lib/project-id.ts";
import { inputHash } from "../lib/transcript.ts";

async function main(): Promise<void> {
  const input = JSON.parse(await Bun.stdin.text());
  if (input?.tool_name !== "Skill") return;
  const skillSlug = input?.tool_input?.skill;
  if (typeof skillSlug !== "string" || skillSlug === "") return;
  const cwd =
    typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();

  // allowlist フィルタ: 列挙されたスキルのみ記録。無い/未列挙なら何もしない（明示 opt-in、spec §3）
  const allowlistPath = join(cwd, ".claude", "friction-skills.yaml");
  if (!existsSync(allowlistPath)) return;
  const allow = parseYaml(readFileSync(allowlistPath, "utf8"));
  const skills: unknown[] = Array.isArray(allow?.skills) ? allow.skills : [];
  if (!skills.includes(skillSlug)) return;

  // skill_content_hash: 発動時点の SKILL.md 内容ハッシュ（見つからなければ null。spec §4）
  const skillMd = join(cwd, ".claude", "skills", skillSlug, "SKILL.md");
  const skillContentHash = existsSync(skillMd)
    ? "sha256:" + createHash("sha256").update(readFileSync(skillMd)).digest("hex")
    : null;

  const pid = projectId(cwd);
  const dataDir = join(homedir(), ".claude", "friction-data", pid);
  mkdirSync(dataDir, { recursive: true });
  const record = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    session_id: typeof input.session_id === "string" ? input.session_id : "",
    tool_use_id:
      typeof input.tool_use_id === "string" && input.tool_use_id !== ""
        ? input.tool_use_id
        : null,
    skill_slug: skillSlug,
    input_hash: inputHash(input.tool_input),
    skill_content_hash: skillContentHash,
    transcript_path:
      typeof input.transcript_path === "string" ? input.transcript_path : "",
    project_id: pid,
  };
  appendFileSync(join(dataDir, "invocations.jsonl"), JSON.stringify(record) + "\n");
}

try {
  await main();
} catch {
  // 記録失敗でセッションを止めない
}
process.exit(0);
