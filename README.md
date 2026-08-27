# a11yFixer

Experimental v0 harness. It exists to answer one question:

> Is a parent Jira → isolated subtask agents → deterministic feedback → independent review →
> small Draft PR workflow useful enough to continue investing in?

Nothing here is a framework. There is no plugin system, no server, no database, no queue and no
concurrency.

## What it does

```
parent Jira issue
  └─ direct subtasks only (linked issues are context, never scope)
       └─ for each subtask, sequentially:
            fresh git worktree pinned to BASE_SHA
            fresh Claude session  ── bootstrap: read repo instructions → branch name + verify commands
            branch created by the harness
            same session          ── implement
            harness               ── run the repository's verification commands
            same session          ── one repair attempt if they failed, then re-verify
            NEW Claude session    ── independent review: PASS / FAIL / MANUAL_REVIEW_REQUIRED
            NEW Claude session    ── commit message + PR title + PR body from repo conventions
            harness               ── git add / git commit / git push / gh pr create --draft
```

Every subtask branches from the same frozen `BASE_SHA`, so the PRs are independent:

```
BASE_SHA
 ├── RAD-1001
 ├── RAD-1002
 └── RAD-1003
```

## What it does NOT do

- no merging, ever
- no Jira mutation (no comments, transitions or edits)
- no giant combined PR — one subtask, one branch, one Draft PR
- no shared Claude context between subtasks
- no concurrency in v0 (subtasks run sequentially)
- no general bug workflow yet — this v0 is accessibility-shaped
- no hardcoded branch/commit/PR/test conventions: the target repository is the authority

## The core principle

**The harness knows the process. The repository knows the policy. The agent interprets the
repository policy.**

a11yFixer deliberately knows almost nothing about how your repository expects work to be done.
The bootstrap agent discovers `AGENTS.md` (root and nested), `CLAUDE.md`, `CONTRIBUTING.md`,
READMEs, testing/accessibility/architecture docs and `.github` templates itself, and returns the
branch name and verification commands *from what it found*. If your repository documents no
deterministic verification, the agent returns an empty list and the reviewer is told verification
was unavailable — the harness does not invent `npm test`.

## Requirements

- Node.js 20+
- git
- Claude Code CLI (`claude`) on your PATH
- A Claude subscription and `CLAUDE_CODE_OAUTH_TOKEN`
- Jira MCP (Atlassian) configured in your Claude Code environment
- GitHub CLI (`gh`), authenticated
- A target repository whose agent/contributor instructions are actually useful

## Setup

```sh
cd ~/Desktop/a11yFixer
npm install

claude setup-token
export CLAUDE_CODE_OAUTH_TOKEN="..."   # secret: never commit, log or paste it anywhere

gh auth status
```

`CLAUDE_CODE_OAUTH_TOKEN` is a secret. a11yFixer never reads, prints or writes it; it is simply
inherited by the `claude` child processes.

## Run

```sh
npm run a11y-fixer -- \
  https://user-testing.atlassian.net/browse/RAD-85350 \
  --repo ~/path/to/target-repository
```

Flags:

| flag | meaning |
| --- | --- |
| `--repo <path>` | target repository (required) |
| `--model <alias>` | model for every Claude session, e.g. `opus` |
| `--dry-run` | stop each subtask after the branch is created — no implementation, no push, no PR |
| `--allow-missing-token` | skip the `CLAUDE_CODE_OAUTH_TOKEN` check when the machine is already authenticated interactively |

Start with `--dry-run` against a scratch clone. It exercises discovery, worktree creation, the
bootstrap agent and branch naming without writing any code or touching GitHub.

## Where things end up

Each run creates `$TMPDIR/a11y-fixer/<repo>-<PARENT>-<timestamp>/<JIRA-KEY>/`:

- `worktree/` — the isolated checkout and branch
- `artifacts/` — `diff.patch`, `verification.txt`, and the raw JSON from each Claude session

Worktrees are **never** deleted, including on failure. Clean up with
`git -C <repo> worktree prune` after removing the directories.

## Known v0 limitations

- The implementation, review and PR agents run with `--permission-mode bypassPermissions` and
  built-in `Bash` denied (the harness owns command execution). MCP tools are *not* restricted, so
  "do not mutate Jira" is enforced by prompt instruction only, not by permissions.
- Worktrees are clean checkouts with no installed dependencies. If verification needs an install
  step, the bootstrap agent is instructed to return it as the first verification command.
- Exactly one repair attempt. No loops.
- `--tools ""` is deliberately not used to sandbox agents: it removes `ToolSearch`, which is how
  deferred MCP tools (including Jira) get loaded, and silently breaks Jira access.
