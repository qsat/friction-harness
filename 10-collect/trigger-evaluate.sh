#!/bin/bash
# SessionEnd: evaluate をバックグラウンド起動して即 exit 0（spec §5.3）。
# プル型突合が正であり、このフックは即時化トリガーに過ぎない。落ちても
# 次のスキャンで拾われるため信頼性は不要。
set -u
exec 2>/dev/null

HARNESS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

INPUT=$(cat) || exit 0
SESSION_ID=$(command -v jq >/dev/null 2>&1 && jq -r '.session_id // empty' <<<"$INPUT")
CWD=$(command -v jq >/dev/null 2>&1 && jq -r '.cwd // empty' <<<"$INPUT")
[ -n "$CWD" ] || CWD=$(pwd)

if command -v bun >/dev/null 2>&1; then
  if [ -n "$SESSION_ID" ]; then
    (cd "$CWD" && nohup bun "$HARNESS_ROOT/20-evaluate/evaluate.ts" --session "$SESSION_ID" >/dev/null 2>&1 &)
  else
    (cd "$CWD" && nohup bun "$HARNESS_ROOT/20-evaluate/evaluate.ts" >/dev/null 2>&1 &)
  fi
fi
exit 0
