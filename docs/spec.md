# friction-harness 実装仕様書（引き継ぎドキュメント）

Claude Code スキルの改善ループを回すための「摩擦（friction）収集・蒸留ハーネス」を構築する。
本ドキュメントは設計議論の結論をまとめた実装仕様であり、これ単体で実装に着手できることを意図する。

- ランタイム: **Bun**（TypeScript）
- フェーズ: **Phase 1**（settings.json 登録によるローカル試行）。Phase 2 で plugin 化する前提でディレクトリを切る
- 参考にした先行例: everything-claude-code (ECC) continuous-learning-v2。ただしその弱点（LLM 依存の同一性判定、冪等性のなさ、パイプライン未接続）を意図的に回避する設計とする

---

## 1. 目的と完成条件（ゴールから逆算)

### 目的
スキル利用時にエージェントが遭遇した課題（摩擦）を構造化ログとして蓄積し、
「どのスキルの・どの種類の問題が・何回起きたか」を決定論的に集計できるようにする。
集計結果はスキル本文の改訂（supersede）と分類語彙（taxonomy)の進化の両方を駆動する。

### Phase 1 の完成条件
1. スキル発動が 100% `invocations.jsonl` に記録される（フック経由・決定論的）
2. セッション転写から issue が抽出され、全 issue が `(session_id, anchor_uuid)` で転写原文まで遡れる
3. `report.ts` が alias 解決込みで issue_type 別 × skill 別の集計を出力できる
4. 同じ転写範囲を二重処理しても issues が重複しない（冪等）
5. taxonomy v1 凍結の判断材料として **other 率**が計測できる（凍結条件: other 率 < 20%)
6. スキル改訂の取り込みが resolutions.jsonl に記録され、report.ts が open / resolved / verified / reopened を
   ログのみから導出できる(状態フラグの保存ゼロ)

### 非目標（Phase 1 ではやらない)
- サブエージェント（sidechain)転写の解析（`agent_type` の記録のみ行う)
- SQLite 化（ファイルベースで開始。alias 解決を跨いだ集計が重くなったら移行)
- taxonomy/aliases の自動コミット（昇格は人間レビュー必須)
- plugin としての配布（Phase 2)

---

## 2. 設計原則（変更不可の固定点)

1. **不変ログ + 読み取り時写像**: `issues.jsonl` はいかなる処理でも書き換えない。
   issue_type のリグルーピングは集計時に `aliases.yaml` を適用して行う（物理的な再分類はしない)。
2. **決定論的な骨格 / 確率論的な意味抽出の分離**:
   - グルーピングキー（skill_slug, issue_type, anchor)は**出力時に確定**させる
   - LLM の仕事は「自由記述 detail の生成」と「enum への分類」のみに縮小する
3. **プル型突合（reconciliation)**: 抽出はフック発火に依存しない。
   転写ディレクトリと処理台帳（ledger)の差分スキャンが正であり、SessionEnd フックは即時化トリガーに過ぎない。
4. **書き込み権の一方向性**:
   - フック → `data/` のみ
   - evaluator → `issues.jsonl` と `ledger.jsonl` のみ
   - `resolutions.jsonl` → 取り込み(スキル改訂)を行った人間または改訂セッションのみ
   - `taxonomy.yaml` / `aliases.yaml` → promote 経由の人間のみ
5. **状態を保存しない(導出ビュー)**: 「未対応 issue」「取り込み済み」「修正の検証結果」は
   どこにもフラグとして保存しない。すべて読み取り時に 3 本の追記ログ
   (invocations / issues / resolutions)から導出する(イベントソーシング: ログ=イベントストア、report=projection)。
   - open issues = issues − resolutions
   - verified / reopened = resolutions の skill_commit 境界と invocations の skill_content_hash の突合で判定
6. **supersede, don't accumulate**: スキル改訂は既存記述の書き換え・削除であり、注意書きの追記は原則禁止。
   行数バジェットをフックで機械的に強制する。

---

## 3. ディレクトリ構成

### ハーネス本体（独立リポジトリ。将来の plugin ルート)

```
friction-harness/
├── hooks/
│   ├── log-skill-use.sh        # L1: スキル発動記録（PostToolUse, matcher: Skill）
│   ├── guard-skill-size.sh     # SKILL.md 行数バジェット強制（PostToolUse, matcher: Edit|Write）
│   └── trigger-evaluate.sh     # SessionEnd: evaluate をバックグラウンド起動して即 exit 0
├── prompts/
│   └── evaluator.md            # 抽出プロンプト（taxonomy を埋め込んで動的生成する）
├── scripts/
│   ├── lib/
│   │   ├── project-id.ts       # git remote URL → 12桁ハッシュ（マシン間で安定）
│   │   ├── transcript.ts       # 転写 JSONL のパースとアンカー解決
│   │   └── ledger.ts           # カーソル台帳の読み書き
│   ├── evaluate.ts             # L2: 突合バッチ本体
│   ├── report.ts               # 集計（alias 解決はここでのみ）
│   └── promote.ts              # candidate クラスタリング → 昇格提案
├── taxonomy/
│   ├── taxonomy.yaml           # 分類語彙（git 管理・グローバル）
│   └── aliases.yaml            # candidate/旧type → 正規 type の写像（git 管理）
└── package.json                # bun 用。依存は最小限（yaml パーサ程度）
```

### 可変データ（plugin 外・.gitignore 相当。配布物に含めない)

```
~/.claude/friction-data/<project-id>/
├── invocations.jsonl           # L1: スキル発動ログ（追記専用）
├── issues.jsonl                # L2: 抽出された摩擦（追記専用・不変）
├── resolutions.jsonl           # 取り込み記録（追記専用・不変。人間/改訂セッションのみ書き込み可）
└── ledger.jsonl                # 処理カーソル台帳（追記専用、session_id ごとに最終行が有効）
```

`<project-id>` は `git remote get-url origin` の SHA-256 先頭12桁。remote がない場合は cwd の絶対パスのハッシュにフォールバック。

### 対象プロジェクト側

```
<repo>/
├── CLAUDE.md                   # 下記の摩擦明示ルールを 1 行追記
└── .claude/
    ├── settings.json           # Phase 1: friction-harness を絶対パスで参照してフック登録
    └── skills/<skill-slug>/
        ├── SKILL.md            # ルーター構造（目安 200 行、上限 500 行）
        └── references/         # 詳細手順・エッジケース（バジェット対象外）
```

CLAUDE.md 追記文（全スキル共通・これ 1 行のみ。スキル本文には報告指示を書かない）:

> スキルの指示に従えない場合や解釈に迷った場合は、その場で「[skill-friction] <スキル名>: <内容>」と一言明示すること。

---

## 4. データスキーマ（契約)

### invocations.jsonl（フックが追記)
```json
{"ts":"2026-07-08T10:30:00Z","session_id":"<uuid>","tool_use_id":"toolu_xx | null",
 "skill_slug":"aidlc-planning","input_hash":"sha256:<hex>",
 "skill_content_hash":"sha256:<発動時点の SKILL.md の SHA-256>",
 "agent_type":"main","project_id":"a1b2c3d4e5f6"}
```
- `tool_use_id` はフック stdin から取得するが、**null / 欠落する既知バグがある**
  （anthropics/claude-code issue #13241)。そのため `input_hash`（tool_input の正規化 JSON の SHA-256)を常に持たせる。
- null の場合の解決は evaluate.ts 側で行う: 転写内で tool 名と input が一致する直近の tool_use ブロックを探す。
- `skill_content_hash` は発動時点の SKILL.md 内容ハッシュ。issue が「どの版のスキルに対するものか」を
  読み取り時に判定するための鍵であり、修正の verified / reopened 判定(§5.6)に使う。

### issues.jsonl（evaluator が追記・不変)
```json
{"id":"iss-<ulid>","session_id":"<uuid>","anchor_uuid":"<転写行のuuid>",
 "skill_slug":"aidlc-planning","issue_type":"ambiguous-instruction",
 "issue_type_candidate":null,"detail":"<自由記述・コード断片は含めない>",
 "severity":"low|mid|high","taxonomy_version":"v0","evaluator_version":"v0",
 "offset_range":[0,412],"extracted_at":"..."}
```
- `issue_type` が `other` のときのみ `issue_type_candidate` に slug 形式の候補を入れる。
- 冪等キーは `(session_id, offset_range)`。同一キーの再抽出結果は書き込まない。

### resolutions.jsonl(取り込み台帳。人間 or 改訂セッションが追記・不変)
```json
{"id":"res-<ulid>","group_key":"aidlc-planning/ambiguous-instruction",
 "issue_ids":["iss-...","iss-..."],"action":"supersede | split | wontfix",
 "skill_commit":"<改訂コミット hash>",
 "skill_content_hash_after":"sha256:<改訂後 SKILL.md の SHA-256>",
 "note":"<改訂の要旨>","resolved_at":"..."}
```
- `group_key` は alias 解決済みの `skill_slug/正規 issue_type`。
- issues.jsonl に status を書き込むことは禁止。open issue は読み取り時に issues − resolutions で導出する。
- `action: wontfix` は「スキル欠陥ではなくエージェント側の誤読等」と判断したケースの記録用。

### ledger.jsonl（カーソル台帳)
```json
{"session_id":"<uuid>","transcript_path":"...","processed_lines":412,"last_run":"..."}
```
- 追記専用。session_id ごとに最終行が現在のカーソル。
- **processed はブール値にしない**。セッションは `--resume` で伸びるため行数カーソル方式とする。

### taxonomy.yaml
```yaml
version: v0
types:
  - {slug: ambiguous-instruction,   status: provisional, since: v0, description: 複数解釈が可能でエージェントが推測で埋めた}
  - {slug: missing-instruction,     status: provisional, since: v0, description: 必要な手順・判断基準がスキルに存在しない}
  - {slug: conflicting-instruction, status: provisional, since: v0, description: 他スキル/CLAUDE.md/ルールと矛盾}
  - {slug: outdated-content,        status: provisional, since: v0, description: コードベースや方針の現状と乖離}
  - {slug: wrong-granularity,       status: provisional, since: v0, description: 手順が細かすぎ/粗すぎて実態に合わない}
  - {slug: trigger-mismatch,        status: provisional, since: v0, description: 発動すべき場面で発動しない、または誤発動}
  - {slug: execution-friction,      status: provisional, since: v0, description: 指示は正しいが環境・ツール側で失敗}
  - {slug: other,                   status: established, since: v0, description: candidate 行き}
```
- 運用ルール: enum は上限 10。超過時は統合を検討。status は provisional → established → superseded。
- v0 は全 type を provisional で開始し、2〜3 週間の candidate 主体運用の後、実ログから v1 を凍結する。

### aliases.yaml
```yaml
# from（candidate 文字列 or superseded type） → to（正規 type）
- {from: unclear-phase-boundary, to: ambiguous-instruction, added: 2026-07-08}
```

---

## 5. コンポーネント仕様

### 5.1 hooks/log-skill-use.sh（レイヤー1)
- 登録: PostToolUse、matcher は Skill ツール（スキル発動)のみ。
- stdin JSON から `session_id, tool_use_id, tool_input, agent_type, cwd` を抽出。
- `tool_input` からスキル slug を取り出し、対応する SKILL.md の SHA-256 を計算して
  `skill_content_hash` に含め、invocations.jsonl に 1 行追記。
- project-id 解決は cwd 基準。git サブプロセスは 1 回に抑える（結果を env/tmp にキャッシュ可)。
- **必ず exit 0**（記録失敗でセッションを止めない)。処理は数十 ms に収める。

### 5.2 hooks/guard-skill-size.sh
- 登録: PostToolUse、matcher: `Edit|Write`。
- `tool_input.file_path` が `**/skills/*/SKILL.md` にマッチする場合のみ `wc -l` チェック。
- 500 行超過: exit 2 + stderr で「行数バジェット超過。追記ではなく references/ への切り出しまたは既存記述の書き換え（supersede)を行うこと」を返す。
- 200〜500 行: 非ブロックの警告（stderr、exit 0)。

### 5.3 hooks/trigger-evaluate.sh
- 登録: SessionEnd。
- `nohup bun <harness>/scripts/evaluate.ts --session <session_id> &` を投げて**即 exit 0**。
- フックのタイムアウトに掛からないこと。落ちても次のスキャンで拾われるため信頼性は不要。

### 5.4 scripts/evaluate.ts（レイヤー2・中核)
処理フロー:
1. `~/.claude/projects/<project-slug>/*.jsonl` をスキャン（`--session` 指定時はそのファイルのみ)。
2. ledger と突合し、未処理範囲（カーソル以降の行)を持つ転写を列挙。
3. 未処理範囲をパースし、invocations.jsonl のレコードをアンカー解決:
   - tool_use_id があれば転写内の一致する tool_use ブロックの行 `uuid` を取得
   - null なら tool 名 + input_hash で直近一致を探すフォールバック
4. 転写テキストのアンカー位置に `[SKILL: <slug> invoked, anchor=<uuid>]` マーカーを挿入。
   抽出ウィンドウは「アンカー → 次のスキルアンカー（または転写末尾)」で近似区切り。
5. `claude -p --model haiku`（または API)に evaluator.md + マーカー入り転写を投入。
   出力は JSON 配列のみを要求（プリアンブル・コードフェンス禁止を明示)。
6. 出力をバリデーション（issue_type が taxonomy に存在するか、anchor_uuid がマーカー集合に含まれるか)し、
   不正レコードは破棄してログに残す。
7. 冪等キー `(session_id, offset_range)` を確認のうえ issues.jsonl に追記、ledger を更新。

注意事項:
- 転写行は `uuid` / `parentUuid` の連鎖構造。アンカーは**行番号ではなく uuid** で持つ（resume/分岐耐性)。
- 転写は `cleanupPeriodDays`（デフォルト 30 日程度)で自動削除されるため、バッチはその窓内で回す前提。
- スキル発動ゼロの範囲は LLM を呼ばずスキップ（コスト最適化)。
- CLAUDE.md の摩擦明示ルールにより転写に残った `[skill-friction]` 発言は最優先の抽出対象。

### 5.5 prompts/evaluator.md
- taxonomy.yaml の type 一覧（slug + description)をテンプレート展開して埋め込む。
- 指示の骨子:
  1. まず既存 enum への分類を試みる。適合度が低い場合のみ `other` + `issue_type_candidate`（slug 形式)
  2. candidate は既存 candidate 一覧（issues.jsonl から抽出して渡す)の再利用を優先し、乱立させない
  3. 全 issue に anchor_uuid を必須で付与。マーカーにない uuid は使用禁止
  4. detail にコード断片・機密を含めない。パターンの記述のみ
  5. 出力は JSON 配列のみ

### 5.6 scripts/report.ts
- issues.jsonl を読み、`aliases.yaml` を適用（from → to の写像。superseded type も同様に解決)してから集計。
- 出力: issue_type × skill_slug のクロス集計、other 率、candidate 上位、
  「issue close 時にスキル行数が増えていないか」の健全性チェック（git log と突合できれば尚可)。
- invocations.jsonl と join し「発動あり・issue ゼロ」の分母(健全率)も出す。
- **導出ビュー(状態はここでのみ計算する)**:
  - open issues = alias 解決済み issues のうち、resolutions の issue_ids に含まれないもの。
    グループ単位で件数を出し、取り込み閾値(同一 group_key 3 件以上、または severity: high 1 件)を
    超えたグループを「改訂候補」として出力する
  - 修正検証: resolution 後、`skill_content_hash_after` の版で発動した invocations を分母に、
    同一 group_key の新規 issue を突合。N 回(初期値 5)発動して再発ゼロ → **verified**、
    再発あり → **reopened** として出力。issue グループのライフサイクルは
    reported → acknowledged(候補入り) → resolved(claimed) → verified / reopened

### 5.7 scripts/promote.ts
- `other` の candidate が 5 件以上のクラスタを LLM に提案させる(クラスタリング自体も LLM で可。
  ただし**提案止まり**とし、taxonomy.yaml / aliases.yaml への反映は人間が手動で行う)。
- 昇格基準: 出現数 ≥ 5 かつ既存 type にマップ不能。
- 統合・廃止も同機構: 旧 type を `status: superseded` にし、aliases に写像を追加。

### 5.8 スキルへの取り込みフロー(蒸留後・グループ単位)
1. report.ts の「改訂候補」グループ(閾値超過)を確認する。**生 issue 単発からの直接改訂は禁止**
   (単発の issue はエージェントの主張であり、誤読か仕様欠陥か未確定のため)。
2. グループ内の issue の detail と anchor_uuid から転写原文を確認し、スキル欠陥と判断したら
   SKILL.md を改訂(§2 の supersede 原則。行数バジェットはフックが強制)。
   エージェント側の問題なら `action: wontfix` で記録する。
3. 改訂コミット後、resolutions.jsonl に 1 行追記(group_key, issue_ids, skill_commit,
   skill_content_hash_after)。
4. 以降の検証は自動: report.ts が新ハッシュでの発動と再発を突合し verified / reopened を導出する。
   reopened になったグループは再び改訂候補に戻る。

---

## 6. settings.json 登録例（Phase 1)

対象リポジトリの `.claude/settings.json`:
```json
{
  "hooks": {
    "PostToolUse": [
      {"matcher": "Skill",
       "hooks": [{"type": "command", "command": "/abs/path/friction-harness/hooks/log-skill-use.sh"}]},
      {"matcher": "Edit|Write",
       "hooks": [{"type": "command", "command": "/abs/path/friction-harness/hooks/guard-skill-size.sh"}]}
    ],
    "SessionEnd": [
      {"hooks": [{"type": "command", "command": "/abs/path/friction-harness/hooks/trigger-evaluate.sh"}]}
    ]
  }
}
```
※ Skill 発動時のツール名・stdin スキーマは実装時に実機で 1 セッション分の転写と hook 入力をダンプして確認すること（バージョンにより差異がある)。ここが本仕様で唯一の未検証ポイント。

---

## 7. 実装順序(推奨)

1. **観測の確認**: ダミーフック(stdin を tmp にダンプするだけ)を Skill / Edit に張り、
   実際の stdin JSON と転写 JSONL の構造を確認。tool_use_id の有無をここで実測する
2. lib/(project-id, transcript, ledger)+ log-skill-use.sh → invocations が溜まることを確認
3. evaluate.ts をアンカー解決まで(LLM なし)実装し、マーカー入り転写が正しく出ることを確認
4. evaluator.md + LLM 呼び出しを接続、issues.jsonl まで通す
5. report.ts / guard-skill-size.sh / trigger-evaluate.sh
6. promote.ts(candidate が実際に溜まってからで良い)

## 8. 既知の落とし穴(再掲)

- tool_use_id が hook 入力で null になるバグ → input_hash フォールバック必須
- SessionEnd は強制終了・クラッシュで発火しない → プル型突合が正、フックは即時化トリガー
- 転写の自動削除(約 30 日) → 抽出済みデータは自前ストアに残るので実質問題ないが、バッチ停止を放置しない
- サブエージェント転写は sidechain 別記録 → Phase 1 は対象外、agent_type の記録のみ
- LLM 出力の冪等性は信用しない → 冪等キーとバリデーションで構造的に担保
