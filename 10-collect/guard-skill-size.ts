#!/usr/bin/env bun
/**
 * SKILL.md 行数バジェット強制（PostToolUse, matcher: Edit|Write）。spec §5.2
 * supersede, don't accumulate（spec §2-6）をフックで機械的に強制する。
 * 500 行超過: exit 2（ブロック）/ 200〜500 行: 警告のみ（exit 0）。
 */
import { existsSync, readFileSync } from "node:fs";

let exitCode = 0;
try {
  const input = JSON.parse(await Bun.stdin.text());
  const filePath = input?.tool_input?.file_path;
  if (
    typeof filePath === "string" &&
    /\/skills\/.+\/SKILL\.md$/.test(filePath) &&
    existsSync(filePath)
  ) {
    const content = readFileSync(filePath, "utf8");
    const newlines = (content.match(/\n/g) ?? []).length;
    const lines =
      newlines + (content.length > 0 && !content.endsWith("\n") ? 1 : 0);
    if (lines > 500) {
      console.error(
        `行数バジェット超過（${lines}行 > 上限500行）: ${filePath} — 追記ではなく references/ への切り出しまたは既存記述の書き換え（supersede）を行うこと`,
      );
      exitCode = 2;
    } else if (lines > 200) {
      console.error(
        `警告: SKILL.md が ${lines} 行（目安200行超・上限500行）: ${filePath} — 肥大化に注意`,
      );
    }
  }
} catch {
  // 判定不能ならブロックしない
}
process.exit(exitCode);
