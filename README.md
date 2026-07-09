# friction-harness

Claude Code スキルの改善ループを回すための、摩擦（friction）収集・蒸留ハーネス。

スキル利用時にエージェントが遭遇した課題を構造化ログとして蓄積し、「どのスキルの・どの種類の
問題が・何回起きたか」を決定論的に集計する。詳細な設計は [docs/spec.md](docs/spec.md) を参照。

現在は Phase 1（対象プロジェクトの `.claude/settings.json` へフックを直接登録するローカル運用）。
Phase 2 で Claude Code plugin として配布する前提でディレクトリを切ってある。

## 前提

- [Bun](https://bun.sh) がインストール済みで `bun` が PATH にあること
- `claude` CLI が PATH にあること（`20-evaluate`/`40-promote` が `claude -p --model haiku` を呼ぶ）
- 対象プロジェクトが git 管理下にあること（project-id の解決に使う。無くても cwd パスにフォールバックする）

## インストール手順（対象プロジェクトへの導入）

### 1. このリポジトリを clone し、依存を入れる

```bash
git clone <this-repo-url> /path/to/friction-harness
cd /path/to/friction-harness
bun install
```

以降、`/path/to/friction-harness` を **絶対パス**で参照する。相対パスは使わない。

### 2. 対象プロジェクトの `.claude/settings.json` にフックを登録する

対象プロジェクトの `.claude/settings.json` に以下を追記する（既存の hooks 設定があるなら
`PostToolUse`/`SessionEnd` の配列にマージする）。`/path/to/friction-harness` は実際の絶対パスに置き換える。

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Skill",
        "hooks": [
          { "type": "command", "command": "/path/to/friction-harness/10-collect/log-skill-use.ts" }
        ]
      },
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "/path/to/friction-harness/10-collect/guard-skill-size.ts" }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "/path/to/friction-harness/10-collect/trigger-evaluate.ts" }
        ]
      }
    ]
  }
}
```

各フックの役割:

| フック | イベント | 役割 |
|---|---|---|
| `log-skill-use.ts` | PostToolUse (Skill) | allowlist 登録スキルの発動を記録する |
| `guard-skill-size.ts` | PostToolUse (Edit\|Write) | SKILL.md が 500 行を超えたら編集をブロックする |
| `trigger-evaluate.ts` | SessionEnd | セッション転写の評価をバックグラウンドで起動する |

### 3. 記録対象スキルの allowlist を作る（明示 opt-in）

対象プロジェクトに `.claude/friction-skills.yaml` を作成し、記録したいスキルの slug を列挙する。
**このファイルが無い、または列挙されていないスキルは記録されない**（誤って全スキルを収集しない
ための明示 opt-in）。

```yaml
skills:
  - aidlc-planning
  - another-skill
```

### 4. CLAUDE.md に摩擦明示ルールを 1 行追記する

対象プロジェクトの `CLAUDE.md`（無ければ作成）に、以下の 1 行を追記する。エージェントが
スキルの指示に迷ったときにこの一言を発言することで、抽出の最優先シグナルになる。

```
スキルの指示に従えない場合や解釈に迷った場合は、その場で「[skill-friction] <スキル名>: <内容>」と一言明示すること。
```

### 5. 動作確認

allowlist に登録したスキルを一度発動させたセッションを実行したあと、記録されているか確認する。

```bash
# project-id は git remote origin URL のハッシュ（無ければ cwd 絶対パスのハッシュ）
cat ~/.claude/friction-data/<project-id>/invocations.jsonl
```

`SessionEnd` フック経由で `20-evaluate/evaluate.ts` がバックグラウンド起動し、しばらくすると
`issues.jsonl` に抽出結果が追記される。手動で即時実行することもできる:

```bash
cd /path/to/target-project
bun /path/to/friction-harness/20-evaluate/evaluate.ts
```

### 6. 集計を見る

```bash
cd /path/to/target-project
bun /path/to/friction-harness/30-report/report.ts
```

`issue_type × skill_slug` のクロス集計、other 率、健全率、改訂候補グループなどが出力される
（`--json` で機械可読形式）。

## 複数プロジェクトへの導入

friction-harness 本体は 1 箇所に clone すれば十分。対象プロジェクトごとに手順 2〜4（settings.json
の登録、allowlist、CLAUDE.md）を繰り返す。データは `~/.claude/friction-data/<project-id>/` に
project-id ごと（= プロジェクトごと）に分離して溜まる。

## taxonomy の運用

`taxonomy/taxonomy.yaml`・`taxonomy/aliases.yaml` はこのハーネス本体が持つグローバル語彙で、
全プロジェクト共通。分類が増えてきたら `40-promote/promote.ts` で昇格提案を出し、
人間がレビューして手動で反映する（自動コミットはしない）。

```bash
bun /path/to/friction-harness/40-promote/promote.ts --project-id <id>
```

## テスト

```bash
cd /path/to/friction-harness
bun test
```

## 詳細仕様

設計原則・データスキーマ・各コンポーネントの詳細は [docs/spec.md](docs/spec.md) を参照。
