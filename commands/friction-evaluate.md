---
description: セッション転写の突合バッチ（evaluate）を手動実行して摩擦を抽出する
argument-hint: "[--session <session_id> / --dry-run / --project-id <id> など]"
allowed-tools: Bash(bun:*)
---

friction-harness の evaluate バッチ（未処理転写からの摩擦抽出）を手動実行する。

1. Bash で `bun "${CLAUDE_PLUGIN_ROOT}/20-evaluate/evaluate.ts" $ARGUMENTS` を実行する。
   LLM 呼び出しを含むため数十秒〜数分かかることがある。timeout は 10 分程度に設定すること。
2. stderr に `unresolved anchor` や `discarded record` があれば、そのまま列挙して報告する。
3. 完了後、`~/.claude/friction-data/<project-id>/issues.jsonl` の増分（今回追記された issue の
   件数と issue_type の内訳）を報告する。

処理は冪等（ledger カーソル + 冪等キー）であり、複数回実行しても issues は重複しない。
issues.jsonl / ledger.jsonl を手で編集してはならない。
