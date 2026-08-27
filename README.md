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
            fresh Claude session  ── claim Jira: assign to you + move to In Progress
            implementation session ── implement
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
- no Jira mutation beyond claiming a subtask — see below. No comments, no resolving, no field
  edits, and nothing at all is ever moved to Done
- no giant combined PR — one subtask, one branch, one Draft PR
- no shared Claude context between subtasks
- no concurrency in v0 (subtasks run sequentially)
- no general bug workflow yet — this v0 is accessibility-shaped
- no hardcoded branch/commit/PR/test conventions: the target repository is the authority

## Jira access is verified, never assumed

Claude Code defers MCP tools when many servers are configured. With ~350 tools available, an
agent that runs a *semantic* `ToolSearch` ("jira atlassian issue") can get nothing back and
conclude Jira is unavailable — then carry on and implement from the issue key alone. That failure
is silent and it makes every downstream result untrustworthy.

Two defences:

1. **Exact tool loading.** Every Jira-touching prompt is given the tool's full name and told to
   load it with an exact select query, which is deterministic:

   ```
   ToolSearch({ query: "select:mcp__claude_ai_Atlassian__getJiraIssue" })
   ```

   The discovery agent reports the tool name it actually used, and that name is threaded into
   every later agent. Override with `--jira-tool <mcp__server__tool>` if your server is named
   differently.

2. **Fetch once, verify, then work from the file.** Before a worktree does anything else, a small
   dedicated session transcribes the subtask verbatim to
   `artifacts/<KEY>.jira.md`. The harness checks the result is a real ticket — the agent claimed
   success, the text is long enough, and it mentions the issue key. It retries once. **If it still
   fails, the subtask fails right there**, before a branch is created or a line of code is
   written:

   ```
   ❌  RAD-85351 failed after 41s
      Jira unavailable: agent reported it could not reach Jira. Refusing to implement a
      ticket that was never read.
   ```

   Bootstrap, implement, review and PR-prep all read that file. They can still query Jira for
   extra detail, but none of them can silently proceed on a guess.

## The one Jira write

Immediately before an implementation agent writes its first line of code, a small dedicated
Claude session claims the subtask:

- assigns it to the Atlassian account your Jira MCP is authenticated as, and
- transitions it to whatever this project's workflow calls its in-progress state.

That is the entire scope of the write. It touches only that subtask, never the parent and never a
linked issue. It does not run in `--dry-run`, it does not run for skipped subtasks, and it never
runs for a subtask that fails before implementation starts. If the claim fails, it is reported as
a warning and the implementation continues — a Jira workflow hiccup should not block engineering
work. The step is prompt-scoped (`prompts/claim-jira.md`), so a subtask that never reaches Step D
is left exactly as it was found.

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
| `--jira-tool <name>` | full MCP tool name for reading Jira; defaults to what discovery reports |

Start with `--dry-run` against a scratch clone. It exercises discovery, worktree creation, the
bootstrap agent and branch naming without writing any code or touching GitHub.

## Terminal output

Long steps (Jira discovery, bootstrap, implementation, verification, review, push, PR creation)
show a spinner with a live elapsed timer, so a step that takes ten minutes never looks hung. When
output is piped or redirected the spinner is skipped and each step prints one plain line instead,
so logs stay readable. `Ctrl-C` restores the cursor.

## Cost and context reporting

Every Claude session reports what it used, read straight from the CLI's JSON response — the
harness estimates nothing:

```
   🧭  bootstrap — reading repository instructions…   1m02s
      └ opus-5  ·  ctx 8% of 1M  ·  ↓ 58.6K  ↑ 1.1K  ·  $0.24
```

with a rollup per subtask and for the whole run:

```
⏱   Wall clock: 2h14m
📊  opus-5   ·   61 Claude sessions   ·   ↓ 8.2M  ↑ 683.2K   ·   $57.34 at list price
    peak context in a single session: 34% of 1M   ·   cache reads 128.1M
```

Three things to read carefully:

- **`ctx N%`** is the largest single turn's prompt divided by the model's context window — the
  fullest that session's context ever got. Isolated per subtask, this is the number that tells you
  whether "one context ≈ one engineering task" is actually holding.
- **`↓`** counts fresh tokens only (new input plus cache writes). Cache reads are reported
  separately because summing them across turns counts the same tokens over and over.
- **`$` is list price, not your bill.** On a Claude subscription these calls are covered by your
  plan. Treat the figure as a relative measure of how expensive a subtask was.

## Where things end up

Each run creates `$TMPDIR/a11y-fixer/<repo>-<PARENT>-<timestamp>/<JIRA-KEY>/`:

- `worktree/` — the isolated checkout and branch
- `artifacts/` — `<KEY>.jira.md` (the verbatim ticket every agent worked from), `diff.patch`,
  `verification.txt`, and the raw JSON from each Claude session

`<KEY>.jira.md` is the file to open when a PR looks wrong: it is exactly what the agents were
told the task was.

Worktrees are **never** deleted, including on failure. Clean up with
`git -C <repo> worktree prune` after removing the directories.

## Known v0 limitations

- Agents run with `--permission-mode bypassPermissions` and built-in `Bash` denied (the harness
  owns command execution). MCP tools are *not* restricted, so "only the claim agent may write to
  Jira" is enforced by prompt instruction, not by permissions.
- The claim agent picks the in-progress transition by meaning, not by exact name. On an unusual
  workflow it may pick the wrong one, or none — check the `📌`/`⚠️` line in the output.
- Worktrees are clean checkouts with no installed dependencies. If verification needs an install
  step, the bootstrap agent is instructed to return it as the first verification command.
- Exactly one repair attempt. No loops.
- `--tools ""` is deliberately not used to sandbox agents: it removes `ToolSearch`, which is how
  deferred MCP tools (including Jira) get loaded, and silently breaks Jira access.
- Deferred MCP tool schemas cost roughly 50K input tokens in every session, which is most of the
  floor cost of a subtask. `--strict-mcp-config` with a hand-declared Atlassian server would fix
  that, but a hand-declared server needs its own OAuth and cannot reuse the claude.ai connector's
  credentials, so v0 does not do it.
- The Jira *write* step (claim) still depends on write tools being loadable at run time. It is
  reported and non-fatal, unlike the read path which is fatal.
