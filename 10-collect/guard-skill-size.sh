#!/bin/bash
# SKILL.md 行数バジェット強制（PostToolUse, matcher: Edit|Write）。spec §5.2
# supersede, don't accumulate（spec §2-6）をフックで機械的に強制する。
set -u

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

FILE_PATH=$(jq -r '.tool_input.file_path // empty' <<<"$INPUT" 2>/dev/null)
[ -n "$FILE_PATH" ] || exit 0

# **/skills/*/SKILL.md のみ対象
case "$FILE_PATH" in
  */skills/*/SKILL.md) ;;
  *) exit 0 ;;
esac
[ -f "$FILE_PATH" ] || exit 0

LINES=$(wc -l < "$FILE_PATH")
if [ "$LINES" -gt 500 ]; then
  echo "行数バジェット超過（${LINES}行 > 上限500行）: $FILE_PATH — 追記ではなく references/ への切り出しまたは既存記述の書き換え（supersede）を行うこと" >&2
  exit 2
elif [ "$LINES" -gt 200 ]; then
  echo "警告: SKILL.md が ${LINES} 行（目安200行超・上限500行）: $FILE_PATH — 肥大化に注意" >&2
fi
exit 0
