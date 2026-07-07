#!/usr/bin/env python3
"""Wake-gate pre-check for the dev-collab dispatcher cron job.

This script prints a single JSON object to stdout for Hermes cron's wake gate:
`{"wakeAgent": true}` when the dispatcher likely has work to do, otherwise
`{"wakeAgent": false}`. Register it on the dispatcher cron job with:

    hermes cron edit <job_id> --script scripts/dev-collab-wake-check.py

The registration itself is intentionally outside this PR's scope. The script
uses only Python's standard library and the `gh` CLI, always scoped to
`ryoryoai/hermes-agent`. If a GitHub query fails or returns unexpected data, it
fails safe by waking the agent.
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

REPO = "ryoryoai/hermes-agent"
OWNER = "ryoryoai"
AGENT_REVIEW_CONTEXT = "agent-review"
PENDING_AGENT_REVIEW_AFTER = timedelta(minutes=30)
RECENTLY_CLOSED_AFTER = timedelta(hours=1)


def _run_gh(args: list[str]) -> Any:
    """Run gh with repo pinned and parse JSON stdout."""
    cmd = ["gh", *args, "-R", REPO]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(
            f"gh command failed ({proc.returncode}): {' '.join(cmd)}\n{proc.stderr.strip()}"
        )
    try:
        return json.loads(proc.stdout or "null")
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"gh command did not return JSON: {' '.join(cmd)}") from exc


def _parse_github_time(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _label_names(item: dict[str, Any]) -> set[str]:
    labels = item.get("labels") or []
    names: set[str] = set()
    for label in labels:
        if isinstance(label, dict) and isinstance(label.get("name"), str):
            names.add(label["name"])
    return names


def _has_unassigned_agent_task() -> bool:
    issues = _run_gh(
        [
            "issue",
            "list",
            "--state",
            "open",
            "--label",
            "agent-task",
            "--limit",
            "100",
            "--json",
            "number,labels",
        ]
    )
    if not isinstance(issues, list):
        raise RuntimeError("gh issue list returned non-list JSON")
    for issue in issues:
        labels = _label_names(issue)
        if "agent-wip" not in labels and "needs-human" not in labels:
            return True
    return False


def _rollup(pr: dict[str, Any]) -> list[dict[str, Any]]:
    rollup = pr.get("statusCheckRollup") or []
    if not isinstance(rollup, list):
        raise RuntimeError(f"PR #{pr.get('number')} has non-list statusCheckRollup")
    return rollup


def _status_state(status: dict[str, Any]) -> str:
    state = status.get("state") or status.get("conclusion") or status.get("status")
    return state.lower() if isinstance(state, str) else ""


def _agent_review_status(pr: dict[str, Any]) -> dict[str, Any] | None:
    for status in _rollup(pr):
        if status.get("context") == AGENT_REVIEW_CONTEXT:
            return status
    return None


def _agent_review_needs_attention(pr: dict[str, Any], now: datetime) -> bool:
    status = _agent_review_status(pr)
    if status is None:
        return True

    state = _status_state(status)
    if state in {"failure", "error", "failed", "timed_out", "cancelled"}:
        return True
    if state in {"pending", "queued", "in_progress", "requested", "waiting"}:
        started_at = _parse_github_time(status.get("startedAt"))
        if started_at is None:
            return True
        return now - started_at > PENDING_AGENT_REVIEW_AFTER
    return False


def _all_checks_green(pr: dict[str, Any]) -> bool:
    rollup = _rollup(pr)
    if not rollup:
        return False
    for check in rollup:
        typename = check.get("__typename")
        if typename == "StatusContext":
            if _status_state(check) != "success":
                return False
            continue
        if typename == "CheckRun":
            conclusion = _status_state({"state": check.get("conclusion")})
            if conclusion not in {"success", "skipped", "neutral"}:
                return False
            continue
        return False
    return True


def _has_open_pr_needing_attention(now: datetime) -> bool:
    prs = _run_gh(
        [
            "pr",
            "list",
            "--state",
            "open",
            "--author",
            OWNER,
            "--limit",
            "100",
            "--json",
            "number,autoMergeRequest,statusCheckRollup",
        ]
    )
    if not isinstance(prs, list):
        raise RuntimeError("gh pr list returned non-list JSON")

    for pr in prs:
        if _agent_review_needs_attention(pr, now):
            return True

        auto_merge = pr.get("autoMergeRequest")
        if _all_checks_green(pr) and not auto_merge:
            return True
    return False


def _has_recently_closed_pr(now: datetime) -> bool:
    prs = _run_gh(
        [
            "pr",
            "list",
            "--state",
            "closed",
            "--author",
            OWNER,
            "--limit",
            "100",
            "--json",
            "number,closedAt,mergedAt",
        ]
    )
    if not isinstance(prs, list):
        raise RuntimeError("gh pr list returned non-list JSON")

    cutoff = now - RECENTLY_CLOSED_AFTER
    for pr in prs:
        closed_at = _parse_github_time(pr.get("mergedAt")) or _parse_github_time(
            pr.get("closedAt")
        )
        if closed_at is not None and closed_at >= cutoff:
            return True
    return False


def should_wake() -> bool:
    now = datetime.now(timezone.utc)
    return (
        _has_unassigned_agent_task()
        or _has_open_pr_needing_attention(now)
        or _has_recently_closed_pr(now)
    )


def main() -> int:
    try:
        wake_agent = should_wake()
    except Exception as exc:  # pragma: no cover - safety fallback for cron use
        print(f"dev-collab wake check failed safe: {exc}", file=sys.stderr)
        wake_agent = True
    print(json.dumps({"wakeAgent": wake_agent}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
