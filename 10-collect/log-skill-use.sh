#!/bin/bash
# L1: スキル発動記録（PostToolUse, matcher: Skill）。spec §5.1
# 記録失敗でセッションを止めないため、いかなる経路でも exit 0 で終える。
set -u
exec 2>/dev/null

finish() { exit 0; }
trap finish ERR

INPUT=$(cat) || finish
command -v jq >/dev/null 2>&1 || finish

TOOL_NAME=$(jq -r '.tool_name // empty' <<<"$INPUT")
[ "$TOOL_NAME" = "Skill" ] || finish

SESSION_ID=$(jq -r '.session_id // empty' <<<"$INPUT")
TOOL_USE_ID=$(jq -r '.tool_use_id // empty' <<<"$INPUT")
TRANSCRIPT_PATH=$(jq -r '.transcript_path // empty' <<<"$INPUT")
CWD=$(jq -r '.cwd // empty' <<<"$INPUT")
SKILL_SLUG=$(jq -r '.tool_input.skill // empty' <<<"$INPUT")
[ -n "$SKILL_SLUG" ] || finish
[ -n "$CWD" ] || CWD=$(pwd)

# allowlist フィルタ: cwd の .claude/friction-skills.yaml に列挙されたスキルのみ記録。
# 設定が無い/空のときは何も記録しない（明示 opt-in）。
ALLOWLIST="$CWD/.claude/friction-skills.yaml"
[ -f "$ALLOWLIST" ] || finish
grep -Eq "^[[:space:]]*-[[:space:]]*[\"']?${SKILL_SLUG}[\"']?[[:space:]]*(#.*)?$" "$ALLOWLIST" || finish

# input_hash: tool_input の正規化 JSON（キー再帰ソート・compact）の SHA-256。
# lib/transcript.ts の inputHash と同一結果になること。
INPUT_HASH="sha256:$(jq -cSj '.tool_input' <<<"$INPUT" | sha256sum | cut -d' ' -f1)"

# skill_content_hash: 発動時点の SKILL.md 内容ハッシュ（spec §4）
SKILL_MD="$CWD/.claude/skills/$SKILL_SLUG/SKILL.md"
if [ -f "$SKILL_MD" ]; then
  SKILL_CONTENT_HASH="sha256:$(sha256sum "$SKILL_MD" | cut -d' ' -f1)"
else
  SKILL_CONTENT_HASH=null
fi

# project-id: git remote origin URL（なければ cwd 絶対パス）の SHA-256 先頭12桁。
# lib/project-id.ts と同一規則。git 呼び出しはこの 1 回のみ。
SOURCE=$(git -C "$CWD" remote get-url origin 2>/dev/null | tr -d '\n')
[ -n "$SOURCE" ] || SOURCE="$CWD"
PROJECT_ID=$(printf '%s' "$SOURCE" | sha256sum | cut -c1-12)

DATA_DIR="$HOME/.claude/friction-data/$PROJECT_ID"
mkdir -p "$DATA_DIR" || finish

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -nc \
  --arg ts "$TS" \
  --arg session_id "$SESSION_ID" \
  --arg tool_use_id "$TOOL_USE_ID" \
  --arg skill_slug "$SKILL_SLUG" \
  --arg input_hash "$INPUT_HASH" \
  --argjson skill_content_hash "$( [ "$SKILL_CONTENT_HASH" = null ] && echo null || echo "\"$SKILL_CONTENT_HASH\"" )" \
  --arg transcript_path "$TRANSCRIPT_PATH" \
  --arg project_id "$PROJECT_ID" \
  '{ts:$ts, session_id:$session_id,
    tool_use_id:(if $tool_use_id=="" then null else $tool_use_id end),
    skill_slug:$skill_slug, input_hash:$input_hash,
    skill_content_hash:$skill_content_hash,
    transcript_path:$transcript_path, project_id:$project_id}' \
  >> "$DATA_DIR/invocations.jsonl" || finish

exit 0
