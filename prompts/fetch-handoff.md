Fetch Jira subtask {{SUBTASK_KEY}} ({{SUBTASK_URL}}) with its comments.

{{JIRA_ACCESS}}

Before this subtask was labelled `{{READY_LABEL}}`, an engineer grilled the work and pasted the
conclusion into a comment under a `{{HANDOFF_MARKER}}` heading. Transcribe the newest such comment
into `handoff`, verbatim, heading included. Another agent builds from it without seeing Jira, so
anything you summarise is a decision that gets silently lost.

If no comment carries that heading, set `found` false. Do not fall back to the description, the
summary, or the newest comment — a missing handoff is an expected answer and the run stops there.

Change nothing in Jira. Return `found`, `key`, `summary`, `commentAuthor`, `commentCreated`,
`handoff`, `error`.
