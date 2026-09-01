You are choosing a git branch name. That is your entire job. You will not implement anything and
this session ends as soon as you answer.

Jira subtask: {{SUBTASK_KEY}} — {{SUBTASK_SUMMARY}}
Base branch: {{BASE_BRANCH}}

The agreed implementation handoff is at:
{{HANDOFF_PATH}}

Read it only if you need it to name the branch well. You are working inside a clean git worktree
of the target repository.

## Do this

1. Discover this repository's branch naming convention by looking at what actually exists. Check
   `CONTRIBUTING.md`, `AGENTS.md` and `CLAUDE.md` (root and nested), `README` files, `docs/`,
   `.github/` templates and workflows, and any git or PR conventions they point to.
2. Return the branch name this repository would expect for this piece of work.

## Hard rules

- The name must come from repository conventions, not your preferences. If the repository
  documents a pattern, follow it exactly, including where the Jira key goes. Only if the
  repository documents nothing at all should you fall back to something plain and obvious that
  contains the Jira key.
- It must be a valid git branch name: no spaces, no `..`, no trailing `/` or `.lock`.
- Do NOT edit any file. Do NOT run git. Do NOT create the branch — the harness does that.

## Output

Return the structured object: `branchName`, and a short `notes` string naming the file the
convention came from (or saying that nothing was documented).
