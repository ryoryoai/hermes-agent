---
name: dev-collab-dispatcher
description: 開発協業の指揮エージェント — ryoryoai/hermes-agentのIssue/PRを点検し、ワーカー割り振り・レビュー起動・差し戻し・エスカレーション・Discord通知を行う
version: 1.0.0
author: Ryohei
license: MIT
metadata:
  hermes:
    tags: [Development, Orchestration, GitHub]
    requires_toolsets: [terminal]
---

# Dev Collab Dispatcher（指揮エージェント）

対象リポジトリ: `ryoryoai/hermes-agent`。全ghコマンドに `-R ryoryoai/hermes-agent` を付ける。
ベースクローン: `/Users/ryohei/projects/hermes-agent`
ワークスペース: `~/agent-workspace/`（初回に `mkdir -p ~/agent-workspace/logs`）
このジョブの最終出力はDiscord #dev に配信される。**通知すべき状態変化がなければ `[SILENT]` とだけ出力する。**

## 毎回の手順

### 1. 状態収集

```bash
gh issue list -R ryoryoai/hermes-agent --label agent-task --state open --json number,title,labels
gh pr list -R ryoryoai/hermes-agent --state open --json number,title,headRefName,statusCheckRollup,body
```

### 2. 新規タスクの割り振り

`agent-task` があり `agent-wip` も `needs-human` もないIssueごとに:

```bash
gh issue edit <N> -R ryoryoai/hermes-agent --add-label agent-wip
gh issue comment <N> -R ryoryoai/hermes-agent --body "dispatcher: ワーカー起動（試行 1/3）"
nohup ~/.local/bin/hermes -q "あなたは開発ワーカー。まずread_fileで /Users/ryohei/.hermes/skills/dev-collab-worker/SKILL.md を読み、その規約に従って ryoryoai/hermes-agent の Issue #<N> を解決せよ。" >> ~/agent-workspace/logs/worker-issue<N>.log 2>&1 &
```

### 3. レビュー起動

open PRのうち、headコミットに `agent-review` statusが**存在しない**ものごとに（多重起動防止のため先にpendingを立てる）:

```bash
SHA=$(gh pr view <PR> -R ryoryoai/hermes-agent --json headRefOid -q .headRefOid)
gh api "repos/ryoryoai/hermes-agent/commits/$SHA/statuses" --jq '[.[] | select(.context=="agent-review")] | length'
# 0 のときだけ:
gh api "repos/ryoryoai/hermes-agent/statuses/$SHA" -f context=agent-review -f state=pending -f description="review in progress"
nohup ~/.local/bin/hermes -q "あなたはレビューエージェント。まずread_fileで /Users/ryohei/.hermes/skills/dev-collab-reviewer/SKILL.md を読み、その手順に従って ryoryoai/hermes-agent の PR #<PR> をレビューせよ。" >> ~/agent-workspace/logs/reviewer-pr<PR>.log 2>&1 &
```

### 4. 差し戻し（CI失敗 / レビューNG）

open PRのうち `statusCheckRollup` に failure（`test`/`e2e`/`agent-review` いずれか）があるものごとに:

1. PR本文の `Closes #<N>` から対応Issueを特定する
2. Issueのコメントから直近の「試行 X/3」を読む
3. X < 3 の場合:

```bash
gh issue comment <N> -R ryoryoai/hermes-agent --body "dispatcher: 差し戻し（試行 <X+1>/3）— 失敗理由: <CIジョブ名 or レビュー指摘の要約>"
nohup ~/.local/bin/hermes -q "あなたは開発ワーカー。まずread_fileで /Users/ryohei/.hermes/skills/dev-collab-worker/SKILL.md を読め。ryoryoai/hermes-agent の PR #<PR>（Issue #<N>）が <失敗理由> で失敗した。既存worktree ~/agent-workspace/issue-<N> で修正し、同じブランチにpushせよ。レビュー指摘は gh pr view <PR> --comments で確認せよ。" >> ~/agent-workspace/logs/worker-issue<N>-retry.log 2>&1 &
```

4. X >= 3 の場合:

```bash
gh issue edit <N> -R ryoryoai/hermes-agent --add-label needs-human
gh issue comment <N> -R ryoryoai/hermes-agent --body "dispatcher: 3回失敗したため人間の判断を仰ぎます"
```

そして最終出力に「⚠️ needs-human: Issue #<N> <title> — 3回失敗」を含める。

**注意: 同一Issueについて前回の差し戻しコメントから15分経っていなければ再起動しない（ワーカー実行中の可能性）。**

### 5. 完了処理

直近にマージされたPR（`gh pr list -R ryoryoai/hermes-agent --state merged --limit 5 --json number,title,body,mergedAt` でmergedAtが直近1時間以内）ごとに、対応Issue #<N> について:

```bash
git -C /Users/ryohei/projects/hermes-agent worktree remove ~/agent-workspace/issue-<N> --force 2>/dev/null || true
git -C /Users/ryohei/projects/hermes-agent fetch origin --prune
```

### 6. 出力

状態変化（着手 / PR作成検知 / レビュー完了 / マージ / 失敗 / エスカレーション）があれば、日本語の簡潔な箇条書きサマリを出力する。何も変化がなければ `[SILENT]` とだけ出力する。

## Pitfalls

- ワーカー/レビュアーの起動は必ず `nohup ... &` で非同期に行い、終了を待たない（cronの非活動タイムアウトに掛かるため）
- `agent-wip` の付与とコメント記録を起動**前**に行う（多重割り振り防止）
- Issue番号やPR番号をプロンプトに埋め込むときは実際の番号に置換すること
