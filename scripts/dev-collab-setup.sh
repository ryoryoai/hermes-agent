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
gh api -X PATCH "repos/$REPO" -F allow_auto_merge=true -F delete_branch_on_merge=true -F has_issues=true >/dev/null

echo "==> 3/5 デプロイ/公開系ワークフロー無効化"
for wf in deploy-site.yml upload_to_pypi.yml skills-index.yml skills-index-freshness.yml; do
  gh workflow disable "$wf" -R "$REPO" 2>/dev/null && echo "    disabled: $wf" || echo "    skip: $wf"
done

echo "==> 3.5/5 calleeワークフロー再有効化"
for wf in ci.yml contributor-check.yml docs-site-checks.yml supply-chain-audit.yml; do
  gh workflow enable "$wf" -R "$REPO" 2>/dev/null && echo "    enabled: $wf" || echo "    skip: $wf"
done

echo "==> 4/5 branch protection (main)"
gh api -X PUT "repos/$REPO/branches/main/protection" --input - <<'JSON' >/dev/null
{
  "required_status_checks": {"strict": false, "contexts": ["All required checks pass", "agent-review"]},
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

echo "done. 次: hermes cron への dev-dispatcher 登録（docs/superpowers/plans/ 参照）"
