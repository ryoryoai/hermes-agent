# hermesエージェント×エンジニア協業開発体制 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** hermesエージェント群（指揮・ワーカー・レビュー）と人間エンジニアが、`ryoryoai/hermes-agent` フォーク上でHITLなしに開発→レビュー→CI→auto-mergeを回す体制を構築する。

**Architecture:** 知的判断（実装・レビュー・割り振り）はこのMacの常駐hermes（cron 3分間隔の指揮エージェント + headlessワーカー/レビュアー）が担い、マージ可否はGitHub branch protection の必須チェック（`test`・`e2e`・`agent-review`）で決定論的に判定する。通知はhermesゲートウェイのDiscord配信を使う。

**Tech Stack:** gh CLI / GitHub Actions（上流 `tests.yml` 流用）/ hermes cron / git worktree / uv+pytest / Discord API

## Global Constraints

- 対象リポジトリ: `ryoryoai/hermes-agent`（`nousresearch/hermes-agent` のフォーク）。全 `gh` コマンドに `-R ryoryoai/hermes-agent` を付ける
- ローカルベースクローン: `/Users/ryohei/projects/hermes-agent`（remote: `origin`=フォーク、`upstream`=nousresearch）
- 必須ステータスチェックのcontext名は正確に `test`, `e2e`, `agent-review`（`tests.yml` のジョブ名に一致）
- エージェント作業場所: `~/agent-workspace/`（worktree: `issue-<N>`、ログ: `logs/`）
- スキルの実行時パス: `~/.hermes/skills/dev-collab-{dispatcher,worker,reviewer}/SKILL.md`（リポジトリ側 `optional-skills/dev-collab/` からコピー）
- ブランチ命名・コミットはCONTRIBUTING.md準拠（`fix/…` `feat/…`、Conventional Commits）
- ローカルの未コミットWIP（`gateway/platforms/discord.py` ほか）は絶対にコミット・stash・checkoutしない
- Discord通知チャンネル: `#dev`（guild: R+Tech）。cron出力が `[SILENT]` のみの場合は配信されない
- 人間の承認をフローのどこにも必須にしない（needs-humanエスカレーションは例外通知であって承認待ちではない）

---

### Task 1: フォーク作成とremote再構成

**Files:**
- なし（GitHub設定とローカルgit設定のみ）

**Interfaces:**
- Produces: `ryoryoai/hermes-agent`（public fork、Actions有効）、ローカルremote `origin`=フォーク / `upstream`=nousresearch。以降の全タスクがこの前提に依存

- [ ] **Step 1: フォーク作成**

```bash
gh repo fork nousresearch/hermes-agent --clone=false
```

Expected: `✓ Created fork ryoryoai/hermes-agent`（既存なら "already exists" でも可）

- [ ] **Step 2: ローカルremote再構成**

```bash
cd /Users/ryohei/projects/hermes-agent
git remote rename origin upstream
git remote add origin https://github.com/ryoryoai/hermes-agent.git
git fetch origin
git fetch upstream
git remote -v
```

Expected: `origin` が ryoryoai/hermes-agent、`upstream` が nousresearch/hermes-agent

- [ ] **Step 3: mainのupstream追跡をoriginへ切替**

```bash
git branch --set-upstream-to=origin/main main 2>/dev/null || echo "originにmainがまだ無い場合はStep 4のpush後に再実行"
```

- [ ] **Step 4: フォークにActionsを有効化し、mainをpush**

```bash
gh api -X PUT repos/ryoryoai/hermes-agent/actions/permissions -F enabled=true -f allowed_actions=all
git push origin main
git branch --set-upstream-to=origin/main main
```

Expected: push成功（この時点ではbranch protection未設定なので直pushできてよい）

- [ ] **Step 5: 検証**

```bash
gh repo view ryoryoai/hermes-agent --json isFork,defaultBranchRef -q '{fork: .isFork, branch: .defaultBranchRef.name}'
```

Expected: `{"branch":"main","fork":true}`

---

### Task 2: dev-collab 3スキルの作成

**Files:**
- Create: `optional-skills/dev-collab/dispatcher/SKILL.md`
- Create: `optional-skills/dev-collab/worker/SKILL.md`
- Create: `optional-skills/dev-collab/reviewer/SKILL.md`

**Interfaces:**
- Produces: スキル名 `dev-collab-dispatcher` / `dev-collab-worker` / `dev-collab-reviewer`。dispatcherはworker/reviewerを `nohup hermes -q "..."` で起動する（プロンプト内でSKILL.mdの絶対パスをread_fileさせる）。reviewerはcommit status `agent-review` をセットする

- [ ] **Step 1: dispatcher/SKILL.md を作成**

````markdown
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
````

- [ ] **Step 2: worker/SKILL.md を作成**

````markdown
---
name: dev-collab-worker
description: 開発ワーカーの作業規約 — git worktreeで隔離実装し、ローカルテスト後にPRを作成してauto-merge予約する
version: 1.0.0
author: Ryohei
license: MIT
metadata:
  hermes:
    tags: [Development, GitHub, Workflow]
    requires_toolsets: [terminal]
---

# Dev Collab Worker（開発ワーカー）

対象リポジトリ: `ryoryoai/hermes-agent`。全ghコマンドに `-R ryoryoai/hermes-agent` を付ける。
ベースクローン: `/Users/ryohei/projects/hermes-agent`（**このディレクトリ内のファイルは直接編集しない**）

## 手順

### 1. 要件把握

```bash
gh issue view <N> -R ryoryoai/hermes-agent --comments
```

### 2. worktree作成（新規タスクの場合）

ブランチ名は変更種別で選ぶ: `fix/<slug>` `feat/<slug>` `docs/<slug>` `test/<slug>` `refactor/<slug>`

```bash
git -C /Users/ryohei/projects/hermes-agent fetch origin
git -C /Users/ryohei/projects/hermes-agent worktree add ~/agent-workspace/issue-<N> -b <branch> origin/main
cd ~/agent-workspace/issue-<N>
```

差し戻しの場合は既存の `~/agent-workspace/issue-<N>` でそのまま作業する。

### 3. 実装

- 変更は最小限に。Issueに書かれたことだけをやる（無関係なリファクタ禁止）
- コミットはConventional Commits: `fix(scope): description`
- **禁止事項**: mainへの直push / テストの無効化・削除・アサーション緩和 / `# noqa` `# type: ignore` の安易な追加 / 秘密情報のコミット

### 4. ローカルテスト（CI と同条件）

```bash
cd ~/agent-workspace/issue-<N>
uv venv .venv --python 3.11
VIRTUAL_ENV="$PWD/.venv" uv pip install -e ".[all,dev]"
OPENROUTER_API_KEY="" OPENAI_API_KEY="" NOUS_API_KEY="" .venv/bin/python -m pytest tests/ -q --ignore=tests/integration --ignore=tests/e2e --tb=short -n auto
```

失敗したら修正して再実行。greenになるまでpushしない。自力で解決できない場合はPRを出さず、Issueに状況をコメントして終了する。

### 5. push と PR作成

```bash
git push -u origin <branch>
gh pr create -R ryoryoai/hermes-agent --base main \
  --title "<Conventional Commits形式のタイトル>" \
  --body "Closes #<N>

## 変更内容
<何をなぜ変えたか>

## テスト
<実行したテストと結果>"
```

### 6. auto-merge予約と報告

```bash
gh pr merge <PR番号> -R ryoryoai/hermes-agent --auto --squash
gh issue comment <N> -R ryoryoai/hermes-agent --body "worker: PR #<PR番号> を作成しました。CI+レビュー通過後に自動マージされます。"
```

## Verification

- `gh pr checks <PR番号> -R ryoryoai/hermes-agent` で test / e2e が実行中または成功していること
- PR本文に `Closes #<N>` が含まれていること（dispatcherの追跡とIssue自動クローズに必須）
````

- [ ] **Step 3: reviewer/SKILL.md を作成**

````markdown
---
name: dev-collab-reviewer
description: レビューエージェントの手順 — PRのdiffをレビューし、コメントとcommit status (agent-review) で判定を返す
version: 1.0.0
author: Ryohei
license: MIT
metadata:
  hermes:
    tags: [Development, CodeReview, GitHub]
    requires_toolsets: [terminal]
---

# Dev Collab Reviewer（レビューエージェント）

対象リポジトリ: `ryoryoai/hermes-agent`。全ghコマンドに `-R ryoryoai/hermes-agent` を付ける。
入力: PR番号 `<PR>`

## 手順

### 1. 対象把握

```bash
SHA=$(gh pr view <PR> -R ryoryoai/hermes-agent --json headRefOid -q .headRefOid)
gh pr view <PR> -R ryoryoai/hermes-agent --json title,body,files
gh pr diff <PR> -R ryoryoai/hermes-agent
```

diffが大きい場合はファイル単位で読む。文脈が必要なら `/Users/ryohei/projects/hermes-agent` の該当ファイルをread_fileで確認する（編集はしない）。

### 2. レビュー観点

1. **正しさ**: ロジックの誤り、エッジケース、例外処理の欠落
2. **セキュリティ**: シェルへのユーザー入力補間に `shlex.quote()` を使っているか / パスアクセス制御前に `os.path.realpath()` しているか / 秘密情報をログに出していないか
3. **クロスプラットフォーム**: `termios`/`fcntl` のImportError+NotImplementedError捕捉 / エンコーディング / `os.setsid` のWindows分岐 / `pathlib.Path` 使用
4. **テスト**: 変更に対応するテストがあるか / 既存テストの無効化・緩和がないか（あれば必ずfailure）
5. **スコープ**: Issueの要件に対して過不足がないか / 無関係な変更が混ざっていないか

### 3. 指摘コメント

指摘がある場合は具体的に（ファイルパス・行・理由・修正案）:

```bash
gh pr review <PR> -R ryoryoai/hermes-agent --comment --body "## エージェントレビュー

- \`path/to/file.py:123\` — <指摘内容と修正案>
..."
```

### 4. 判定

- マージを妨げる問題（バグ・セキュリティ・テスト改ざん・要件未達）がない → `success`
- ある → `failure`（軽微なスタイル指摘だけならsuccessにしてコメントのみ）

```bash
gh api "repos/ryoryoai/hermes-agent/statuses/$SHA" \
  -f context=agent-review \
  -f state=<success|failure> \
  -f description="<判定理由の一行要約(140字以内)>"
```

### 5. 判定理由をPRコメントに残す

```bash
gh pr comment <PR> -R ryoryoai/hermes-agent --body "agent-review: **<success|failure>** — <理由>"
```

## Pitfalls

- statusは必ずPRのhead SHA（`headRefOid`）に対して立てる。古いSHAに立てるとゲートが解除されない
- diffだけで判断できないときは周辺コードを読む。読まずにfailureにしない
````

- [ ] **Step 4: コミット**

```bash
cd /Users/ryohei/projects/hermes-agent
git add optional-skills/dev-collab/
git commit -m "feat(skills): add dev-collab dispatcher/worker/reviewer skills

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: セットアップスクリプト作成

**Files:**
- Create: `scripts/dev-collab-setup.sh`

**Interfaces:**
- Consumes: Task 2のスキルファイル（`optional-skills/dev-collab/*/SKILL.md`）
- Produces: 冪等なセットアップスクリプト。実行するとラベル・リポジトリ設定・ワークフロー無効化・branch protection・スキルインストールが完了する

- [ ] **Step 1: scripts/dev-collab-setup.sh を作成**

```bash
#!/usr/bin/env bash
# dev-collab-setup.sh — エージェント協業開発体制のGitHub側セットアップ（冪等）
set -euo pipefail

REPO="ryoryoai/hermes-agent"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> 1/5 ラベル作成"
gh label create agent-task  -R "$REPO" --color 1D76DB --description "エージェント着手対象" --force
gh label create agent-wip   -R "$REPO" --color FBCA04 --description "エージェント作業中" --force
gh label create needs-human -R "$REPO" --color D93F0B --description "人間の判断が必要" --force

echo "==> 2/5 リポジトリ設定 (auto-merge, ブランチ自動削除)"
gh api -X PATCH "repos/$REPO" -F allow_auto_merge=true -F delete_branch_on_merge=true >/dev/null

echo "==> 3/5 不要ワークフロー無効化 (Tests以外)"
for wf in deploy-site.yml docker-publish.yml nix.yml skills-index.yml supply-chain-audit.yml contributor-check.yml docs-site-checks.yml; do
  gh workflow disable "$wf" -R "$REPO" 2>/dev/null && echo "    disabled: $wf" || echo "    skip: $wf"
done

echo "==> 4/5 branch protection (main)"
gh api -X PUT "repos/$REPO/branches/main/protection" --input - <<'JSON' >/dev/null
{
  "required_status_checks": {"strict": false, "contexts": ["test", "e2e", "agent-review"]},
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON

echo "==> 5/5 スキルインストール (~/.hermes/skills/)"
for s in dispatcher worker reviewer; do
  dest="$HOME/.hermes/skills/dev-collab-$s"
  mkdir -p "$dest"
  cp "$REPO_ROOT/optional-skills/dev-collab/$s/SKILL.md" "$dest/SKILL.md"
  echo "    installed: dev-collab-$s"
done

echo "done. 次: hermes cron への dev-dispatcher 登録（README参照 / plans参照）"
```

- [ ] **Step 2: 実行権限を付けてコミット**

```bash
chmod +x scripts/dev-collab-setup.sh
git add scripts/dev-collab-setup.sh
git commit -m "feat(scripts): add dev-collab GitHub/skills setup script

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: PR #1作成とGitHub側セットアップ実行

**Files:**
- なし（push・PR作成・スクリプト実行）

**Interfaces:**
- Consumes: Task 1のフォーク、Task 2-3のコミット（`feat/agent-collab-infra` ブランチ）
- Produces: open PR（インフラ一式）、branch protection有効、ラベル3種、スキルが `~/.hermes/skills/` にインストール済み

- [ ] **Step 1: ブランチをpushしPR作成**

```bash
cd /Users/ryohei/projects/hermes-agent
git push -u origin feat/agent-collab-infra
gh pr create -R ryoryoai/hermes-agent --base main --head feat/agent-collab-infra \
  --title "feat: add agent-collab dev workflow (skills, setup, spec)" \
  --body "エージェント協業開発体制のインフラ一式。

## 変更内容
- dev-collab 3スキル（dispatcher/worker/reviewer）
- GitHub側セットアップスクリプト
- 設計書・実装計画

## テスト
このPR自体がゲート（test + e2e + agent-review + auto-merge）の初回検証となる。"
```

Expected: PR URL が出力される（番号を控える）

- [ ] **Step 2: セットアップスクリプト実行**

```bash
bash scripts/dev-collab-setup.sh
```

Expected: 5ステップすべて成功、`done.` 出力

- [ ] **Step 3: branch protection検証（main直push拒否）**

```bash
git checkout main
git commit --allow-empty -m "test: protection check"
git push origin main; echo "exit=$?"
git reset HEAD~1   # mixed reset — 空コミットのみ取り消し。working treeのWIPには触れない（--hard 禁止）
git checkout feat/agent-collab-infra
```

Expected: push が `protected branch` エラーで**失敗**（exit≠0）。ローカルの空コミットはresetで消す

- [ ] **Step 4: ラベル検証**

```bash
gh label list -R ryoryoai/hermes-agent | grep -E 'agent-task|agent-wip|needs-human'
```

Expected: 3ラベルが表示される

---

### Task 5: レビューエージェント初回起動とauto-merge完走（テスト計画1・2）

**Files:**
- なし（エージェント起動と観測）

**Interfaces:**
- Consumes: Task 4のPR番号 `<PR>`、`~/.hermes/skills/dev-collab-reviewer/SKILL.md`
- Produces: PR #1がマージされたmain。`agent-review` statusゲートの動作実績

- [ ] **Step 1: auto-merge予約**

```bash
gh pr merge <PR> -R ryoryoai/hermes-agent --auto --squash
```

Expected: `will be automatically merged when all requirements are met`

- [ ] **Step 2: レビューエージェントを手動起動**

```bash
mkdir -p ~/agent-workspace/logs
nohup ~/.local/bin/hermes -q "あなたはレビューエージェント。まずread_fileで /Users/ryohei/.hermes/skills/dev-collab-reviewer/SKILL.md を読み、その手順に従って ryoryoai/hermes-agent の PR #<PR> をレビューせよ。" >> ~/agent-workspace/logs/reviewer-pr<PR>.log 2>&1 &
```

- [ ] **Step 3: レビュー結果を確認（数分待って）**

```bash
gh pr view <PR> -R ryoryoai/hermes-agent --json statusCheckRollup -q '.statusCheckRollup[] | {name: (.context // .name), state: (.state // .conclusion)}'
gh pr view <PR> -R ryoryoai/hermes-agent --comments | tail -30
```

Expected: `agent-review` が success/failure でセットされ、レビューコメントが付いている。failureの場合は指摘を修正して再push（レビュアー再起動）

- [ ] **Step 4: auto-merge完走確認**

```bash
gh pr view <PR> -R ryoryoai/hermes-agent --json state,mergedAt
git checkout main && git pull origin main && git log --oneline -3
```

Expected: `"state": "MERGED"`。test + e2e + agent-review 全green後に人手ゼロでマージされたこと

---

### Task 6: Discord #devチャンネルとdispatcher cron登録

**Files:**
- なし（Discord API と hermes cron 設定）

**Interfaces:**
- Consumes: `~/.hermes/skills/dev-collab-dispatcher/SKILL.md`、hermesゲートウェイ（稼働中）
- Produces: Discordチャンネル `#dev`、3分間隔のcronジョブ `dev-dispatcher`（deliver: `discord:#dev`）

- [ ] **Step 1: Discord botトークンの環境変数名を確認**

```bash
grep -oE '^DISCORD[A-Z_]*' ~/.hermes/.env
```

Expected: `DISCORD_BOT_TOKEN`（異なる名前ならStep 2で読み替える）

- [ ] **Step 2: #devチャンネル作成（存在しなければ）**

```bash
export $(grep '^DISCORD_BOT_TOKEN' ~/.hermes/.env | xargs)
GUILD_ID=$(curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  "https://discord.com/api/v10/users/@me/guilds" | python3 -c "import sys,json; gs=json.load(sys.stdin); print([g['id'] for g in gs if g['name']=='R+Tech'][0])")
curl -s -X POST -H "Authorization: Bot $DISCORD_BOT_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"dev","type":0,"topic":"エージェント協業開発の通知チャンネル"}' \
  "https://discord.com/api/v10/guilds/$GUILD_ID/channels" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id') or d)"
```

Expected: 新チャンネルのIDが出力される（権限エラー`50013`等の場合はDiscordアプリで手動作成し、次へ進む）

- [ ] **Step 3: dispatcher cronジョブ登録**

```bash
hermes cron create "3m" \
  "あなたは開発協業の指揮エージェント。添付のdev-collab-dispatcherスキルの手順に厳密に従い、ryoryoai/hermes-agent のIssueとPRを点検して必要なアクション（割り振り・レビュー起動・差し戻し・エスカレーション・完了処理）を実行せよ。通知すべき状態変化がなければ [SILENT] とだけ出力せよ。" \
  --name dev-dispatcher \
  --deliver "discord:#dev" \
  --skill dev-collab-dispatcher
hermes cron list
```

Expected: `dev-dispatcher` が `every 3m`・`deliver discord:#dev` で登録される

- [ ] **Step 4: 単発実行で動作検証**

```bash
hermes cron run <job_id>
sleep 240
python3 -c "
import json
jobs = json.load(open('$HOME/.hermes/cron/jobs.json'))['jobs']
j = [x for x in jobs if x['name']=='dev-dispatcher'][0]
print('last_status:', j['last_status'], '| last_error:', j['last_error'])
"
ls ~/.hermes/cron/output/ 2>/dev/null | tail -3
```

Expected: `last_status: ok`。処理対象がないので出力は `[SILENT]`（Discordに配信されない）

---

### Task 7: E2Eドライラン（テスト計画3）

**Files:**
- なし（実タスクによる全線通し確認）

**Interfaces:**
- Consumes: 稼働中のdispatcher cron、全ゲート
- Produces: 「Issue登録 → 着手通知 → PR → レビュー → CI → auto-merge → 完了」の人手ゼロ完走実績

- [ ] **Step 1: 軽微な実タスクのIssueを作成**

```bash
gh issue create -R ryoryoai/hermes-agent \
  --title "docs: READMEの軽微なtypo/表記ゆれを1箇所修正" \
  --label agent-task \
  --body "README.md 内の軽微なtypoまたは表記ゆれを1箇所だけ見つけて修正してください。変更は1ファイル・数行以内に収めること。見つからない場合はREADME.md末尾の文言を1箇所だけ読みやすく整えること。"
```

- [ ] **Step 2: dispatcherの着手を観測（次のcron tickまで最大3分 + ワーカー実行時間）**

```bash
sleep 200
gh issue view <Issue番号> -R ryoryoai/hermes-agent --json labels,comments -q '{labels: [.labels[].name], last: .comments[-1].body}'
tail -5 ~/agent-workspace/logs/worker-issue<Issue番号>.log
```

Expected: `agent-wip` ラベルが付き、「dispatcher: ワーカー起動（試行 1/3）」コメントがある

- [ ] **Step 3: PR作成〜マージまで観測（10〜20分）**

```bash
gh pr list -R ryoryoai/hermes-agent --state all --limit 3 --json number,title,state
gh pr view <新PR番号> -R ryoryoai/hermes-agent --json state,statusCheckRollup
```

Expected: ワーカーのPRが作成され、test/e2e/agent-review が全green → MERGED。Discord #dev に着手・レビュー・マージの通知が流れている

- [ ] **Step 4: 事後状態の確認**

```bash
gh issue view <Issue番号> -R ryoryoai/hermes-agent --json state -q .state
git -C /Users/ryohei/projects/hermes-agent worktree list
```

Expected: Issueが `CLOSED`（`Closes #N` により自動クローズ）。worktreeはdispatcherの完了処理で掃除される（次tick以降）

- [ ] **Step 5: 結果サマリをDiscordとユーザーへ報告**

E2E完走の証跡（Issue番号・PR番号・マージ時刻・通知スクリーンショット相当のログ）をまとめて報告する。

---

## 運用メモ（実装後にREADMEではなくここを参照）

- タスク依頼: Issueに `agent-task` ラベルを付ける、またはDiscordでhermesに依頼してIssue化してもらう
- 停止: `hermes cron pause <job_id>`（再開は `resume`）
- エスカレーション対応: `needs-human` ラベルのIssueを人間が処置 → 解決したら `needs-human` と `agent-wip` を外して `agent-task` を付け直せば再度エージェントが着手する
- 上流追従: `git fetch upstream && git merge upstream/main` は人間が明示的に行う（本体制のスコープ外）
