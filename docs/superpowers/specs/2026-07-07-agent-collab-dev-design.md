# hermesエージェント×エンジニア協業開発体制 設計書

日付: 2026-07-07
ステータス: 承認済み（推奨案一括採択）

## 目的

hermesエージェント群と人間エンジニアが、git/GitHubを共通の作業基盤として協業し、
**HITL（人間の承認待ち）を挟まず自律的に** 開発・レビュー・マージ・通知が回る体制を作る。

人間は「必須の承認者」ではなく「いつでも介入できる観察者」として参加する。

## スコープ

- 対象リポジトリ: `ryoryoai/hermes-agent`（`nousresearch/hermes-agent` のフォーク。新規作成する）
- 常駐実行環境: このMac（既に稼働中のhermesゲートウェイ + Discord接続を利用）
- タスク入力経路: GitHub Issues（`agent-task` ラベル）+ Discord（指揮エージェントがIssue化してから着手）
- LLMプロバイダ: 既存設定（openai-codex）をそのまま利用

## アーキテクチャ（ハイブリッド型）

**原則: 知的判断は常駐エージェント、マージ可否の最終ゲートは決定論的なCI。**
HITLを外す以上、「マージしてよいか」の判定はLLMの気分ではなく機械的条件で行う。

```
[人間] --Issue/Discord--> [指揮エージェント (hermes cron, 常駐)]
                             |  割り振り + Discord通知
                             v
                          [ワーカーエージェント (headless hermes, git worktreeで隔離)]
                             |  実装 → ローカルpytest → push → PR作成
                             v
[新PR] --ポーリング検知--> [レビューエージェント]
                             |  diffレビュー → PRコメント + commit status "agent-review"
                             v
[GitHub Actions] test + e2e + agent-review 全green
                             |
                             v
                        auto-merge (squash) → Discordへ完了通知
```

## コンポーネント

### 1. リポジトリ基盤（GitHub側）

- フォーク作成: `gh repo fork nousresearch/hermes-agent`（public）
- ローカルremote張り替え: `origin` = フォーク、`upstream` = nousresearch
- ラベル: `agent-task`（着手対象）、`agent-wip`（作業中）、`needs-human`（エスカレーション）
- リポジトリ設定: auto-merge許可、Actions有効化
- branch protection（main）:
  - PR必須（直push禁止）
  - 必須ステータスチェック: `test`、`e2e`（上流 `tests.yml` のジョブをそのまま流用）、`agent-review`
  - 管理者にも適用（enforce_admins）

### 2. 指揮エージェント（dispatcher）

- 実体: hermes cronジョブ（3分間隔）。`optional-skills/dev-collab/dispatcher/SKILL.md` の手順で動く
- 入力: `gh issue list --label agent-task`、`gh pr list`、CI結果（`gh pr checks`）
- 責務:
  - 未着手Issue（`agent-task` あり、`agent-wip` なし）→ ワーカーをheadless起動して割り振り、`agent-wip` 付与、Discordへ「着手」通知
  - レビュー待ちPR → レビューエージェントを起動
  - CI失敗 / レビューNGのPR → 修正タスクとしてワーカーへ差し戻し（同一Issueにつき最大3回）
  - 3回超過 or 判断不能 → `needs-human` ラベル + Discordメンション
  - 状態遷移（着手・PR作成・レビュー結果・マージ・失敗）を都度Discordチャンネルへ通知
- 多重割り振り防止: `agent-wip` ラベルと Issue コメントに割り振り記録を残すことで冪等化

### 3. ワーカーエージェント（worker）

- 実体: 指揮エージェントが `hermes -q "<タスク指示>"` で起動するheadless hermesセッション。`optional-skills/dev-collab/worker/SKILL.md` の作業規約に従う
- 作業手順:
  1. `~/agent-workspace/issue-<番号>/` にgit worktree作成（mainから分岐、ブランチ名はCONTRIBUTING準拠: `fix/…` `feat/…` 等）
  2. 実装。コミットはConventional Commits
  3. `pytest tests/ -q`（integration/e2e除外）をローカル実行し、green確認後にpush
  4. `gh pr create` でPR作成（本文にIssue参照 `Closes #N`、変更概要、テスト方法）
  5. `gh pr merge --auto --squash` でauto-merge予約
- 完了後worktreeは残置し、マージ確認後に指揮エージェントが掃除

### 4. レビューエージェント（reviewer）

- 実体: 指揮エージェントが起動するheadless hermesセッション。`optional-skills/dev-collab/reviewer/SKILL.md` に従う
- 手順:
  1. `gh pr diff` でdiff取得、必要に応じ周辺コードを読む
  2. 正しさ・セキュリティ（CONTRIBUTINGのセキュリティ規約）・クロスプラットフォーム・テスト有無の観点でレビュー
  3. 指摘は `gh pr comment` / `gh pr review` でPRへ
  4. 判定をcommit statusへ: `gh api repos/:owner/:repo/statuses/<sha> -f context=agent-review -f state=success|failure`
- **approve方式ではなくstatus check方式を採る理由**: PR作者と同一GitHubアカウントでもマージゲートとして機能するため、レビュー専用のマシンアカウント（第2アカウント）が不要になる

### 5. 通知（Discord）

- 既存のhermesゲートウェイDiscord接続を利用し、開発専用チャンネルへ通知
- 通知先チャンネルIDはセットアップ時に既存ゲートウェイ設定（`~/.hermes/config.yaml` / `channel_directory.json`）から選択し、dispatcherスキルに記載する
- 通知イベント: タスク着手 / PR作成 / レビュー結果 / マージ完了 / CI失敗 / needs-humanエスカレーション

### 6. 人間エンジニアの参加

- エージェントと同一フロー: ブランチ → PR → レビューエージェントのレビュー + CI → auto-merge
- タスク依頼: Issueに `agent-task` ラベルを付けるか、Discordで指揮エージェントに依頼（Issue化される）

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| ワーカーのローカルテスト失敗 | ワーカー自身が修正を試み、解決不能ならPRを出さずIssueへ状況コメント → 指揮が差し戻しカウント |
| CI失敗（push後） | 指揮が検知し修正タスクとして差し戻し（最大3回） |
| レビューNG（agent-review: failure） | 同上。レビューコメントを修正指示としてワーカーへ渡す |
| 差し戻し3回超過 | `needs-human` + Discordメンション。エージェントは当該Issueから手を引く |
| ポーリング障害（gh認証切れ等） | cronジョブがエラーをDiscordへ通知 |
| 多重起動 | `agent-wip` ラベルによる冪等チェックで防止 |

## セキュリティ / 安全性

- mainへの直pushはbranch protectionで全員（管理者含む）禁止 — エージェント暴走がmainへ直撃しない
- エージェントのGitHub操作は既存の `gh` 認証（ryoryoai）を利用。スコープはフォークに閉じる
- 上流（nousresearch）への操作は本体制のスコープ外（PRを出す場合は人間が明示指示）
- APIコスト暴走防止: ワーカーは1タスク1セッション、差し戻し上限3回で打ち切り

## 成果物（フォークにコミット）

| パス | 内容 |
|---|---|
| `optional-skills/dev-collab/dispatcher/SKILL.md` | 指揮エージェントの手順書 |
| `optional-skills/dev-collab/worker/SKILL.md` | ワーカーの作業規約 |
| `optional-skills/dev-collab/reviewer/SKILL.md` | レビューエージェントの手順書 |
| `scripts/dev-collab-setup.sh` | ラベル・auto-merge・branch protection・cron登録の一括セットアップ |
| `docs/superpowers/specs/2026-07-07-agent-collab-dev-design.md` | 本設計書 |

## テスト計画

1. **セットアップ検証**: branch protectionが効いていること（main直pushが拒否される）を確認
2. **レビュー単体**: ダミーPRを作り、レビューエージェントがコメント + `agent-review` statusを付けることを確認
3. **E2Eドライラン**: 軽微な実タスク（例: docsのtypo修正）を `agent-task` Issueとして登録し、
   着手通知 → PR → レビュー → CI → auto-merge → 完了通知 まで人手ゼロで完走することを確認

## フェーズ2（今回のスコープ外）

- CD: main更新時に常駐hermesの自己更新（自分自身の実行環境を書き換えるためリスク評価後に導入）
- 上流（nousresearch）への貢献PRの半自動化
- レビューエージェントの複数観点並列化（セキュリティ専任など）
