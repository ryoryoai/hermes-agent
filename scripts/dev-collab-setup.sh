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
