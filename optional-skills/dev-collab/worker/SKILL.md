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
