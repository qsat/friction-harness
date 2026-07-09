---
description: friction レポート（issue_type × skill 集計・other 率・改訂候補・修正検証）を表示する
argument-hint: "[report.ts への追加引数（--json / --project-id <id> など）]"
allowed-tools: Bash(bun:*)
---

## 集計結果

!`bun "${CLAUDE_PLUGIN_ROOT}/30-report/report.ts" $ARGUMENTS`

## タスク

上記の friction レポートをユーザーに提示し、あわせて次を簡潔に報告すること:

- 改訂候補（revision candidates）があれば、その group_key と件数・severity
- 修正検証に reopened があれば最優先で知らせる（改訂候補への復帰を意味する）
- other 率が 0.20 以上なら taxonomy v1 凍結の条件未達であることを添える

出力にある事実のみを述べ、数値の推測や再解釈はしないこと。
issues.jsonl 等のログファイルを直接編集する提案はしないこと（読み取り時導出が設計原則）。
