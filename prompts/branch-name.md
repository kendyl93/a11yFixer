Name the git branch for Jira subtask {{SUBTASK_KEY}} — {{SUBTASK_SUMMARY}} — following this
repository's convention. Base branch: {{BASE_BRANCH}}. The handoff is at {{HANDOFF_PATH}} if you
need it.

Find the convention in the repository rather than inventing one. If nothing documents it, fall
back to something plain containing the Jira key.

Do not create the branch. Return `branchName`, and `notes` naming where the convention came from.
