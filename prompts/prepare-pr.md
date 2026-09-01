Write the commit message and Draft PR text for the change on branch `{{BRANCH_NAME}}`, for Jira
subtask {{SUBTASK_KEY}} ({{SUBTASK_URL}}), following this repository's conventions. Start from
AGENTS.md. No tooling attribution footer.

The diff is at {{DIFF_PATH}}, and the handoff it was built from is at {{HANDOFF_PATH}}.

Return `commitMessage`, `prTitle`, `prBody`. The harness opens the PR as a draft; `commitMessage`
is the fallback for anything the implementer left uncommitted.
