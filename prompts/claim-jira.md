Assign Jira subtask {{SUBTASK_KEY}} ({{SUBTASK_URL}}) to the current Atlassian user, and
transition it to whatever this project's workflow calls its in-progress state — pick by meaning,
not by exact string.

{{JIRA_WRITE_ACCESS}}

Resolve the user with `atlassianUserInfo`; never guess an account id. Change only the assignee and
the status, and only on this issue. Already assigned, or already in progress, is success.

Return `assigned`, `transitioned`, `assignee`, `status`, `error`, `note`. Partial success is fine
— report what actually happened; implementation continues either way.
