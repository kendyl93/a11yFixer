List the direct sub-tasks of {{PARENT_URL}} ({{PARENT_KEY}}) with their labels. A JQL search on
`parent = {{PARENT_KEY}}` gets labels for all of them in one call.

{{JIRA_ACCESS}}

Report every direct sub-task, not just the ones labelled `{{READY_LABEL}}` — the operator needs to
see `ready-for-implementaton` in order to fix it. Filtering happens downstream, in code.

`labels` must be what Jira returned; never infer one from a summary or status. Sub-tasks only:
linked, blocked and epic-child issues are not sub-tasks.

Change nothing in Jira. Return `jiraMcpAvailable`, `jiraToolName` (the exact tool you read with —
later agents reuse the name), `error`, `parent`, and `subtasks` in Jira's order.
