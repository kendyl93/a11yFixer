Implement Jira subtask {{SUBTASK_KEY}} by following this process, verbatim:

<process>
{{IMPLEMENT_SKILL}}
</process>

The work is specified by the handoff at {{HANDOFF_PATH}} — a human already made these decisions.
Build what it says and nothing else. Where it is silent, the repository decides. If it contradicts
itself or is missing something you cannot proceed without, stop and say so rather than deciding it
yourself.

You are on branch `{{BRANCH_NAME}}` in a throwaway worktree checked out at {{BASE_SHA}}; review
against that commit. Commit here and stop — the harness pushes and opens the draft PR, and a human
reviews it. Do not touch Jira ({{SUBTASK_URL}}).
