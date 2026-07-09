---
description: other の candidate から taxonomy 昇格提案を生成する（提案のみ・反映は人間）
argument-hint: "[--min-count <n> / --json / --project-id <id> など]"
allowed-tools: Bash(bun:*)
---

taxonomy 昇格提案（candidate クラスタリング）を生成する。

1. Bash で `bun "${CLAUDE_PLUGIN_ROOT}/40-promote/promote.ts" $ARGUMENTS` を実行する。
   LLM 呼び出しを含むため timeout は 10 分程度に設定すること。
2. 出力された提案（昇格 / 統合）と taxonomy.yaml / aliases.yaml への追記スニペットを
   そのままユーザーに提示する。破棄された不正提案が stderr にあればそれも添える。

**重要**: taxonomy.yaml / aliases.yaml への反映は人間のレビューを経て手動で行う運用である
（spec §2-4 書き込み権の一方向性）。ユーザーの明示的な指示がない限り、これらのファイルを
編集してはならない。提案の提示までがこのコマンドの仕事。
