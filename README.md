# a11yFixer

Discovery is yours. Implementation is the agent's.

You grill each Jira subtask until you know exactly what should be built, paste that conclusion
into the subtask as a comment, and label it. a11yFixer picks up only the labelled subtasks, and
builds only what your comment says — one isolated agent per subtask, one Draft PR each.

## The contract

For every subtask you want implemented:

1. Grill it — `/grilling` in Claude Code, or any other way you like to think it through.
2. Paste the conclusion into the Jira subtask as a **comment**, under a `## Handoff` heading.
3. Add the label **`ready-for-implementation`** to the subtask.

That comment is the specification. Not the ticket description, not the summary, not the agent's
own plan. If a labelled subtask has no `## Handoff` comment, that subtask fails immediately and
loudly — a11yFixer will never fall back to guessing from the ticket:

```
❌  RAD-85351 failed after 38s
   handoff unusable: no `## Handoff` heading in the returned text. RAD-85351 is labelled
   `ready-for-implementation` but carries no `## Handoff` comment — refusing to implement
   from the ticket summary alone.
```

## What it does

```
parent Jira issue
  └─ direct subtasks labelled `ready-for-implementation`   (everything else is ignored)
       └─ for each, sequentially:
            fresh git worktree pinned to BASE_SHA
            fresh Claude session  ── fetch the `## Handoff` comment, verbatim, to a file
            fresh Claude session  ── branch name from this repo's conventions
            harness               ── create the branch
            fresh Claude session  ── claim Jira: assign to you + move to In Progress
            fresh Claude session  ── your implement skill, inlined (/tdd, typecheck, /code-review, commit)
            fresh Claude session  ── PR title + body from this repo's conventions
            harness               ── git push + gh pr create --draft
```

Every subtask branches from the same frozen `BASE_SHA`, so the PRs are independent:

```
BASE_SHA
 ├── RAD-1001
 ├── RAD-1002
 └── RAD-1003
```

## One phase, one context

Every box above is a **separate `claude` process**. Not a sub-agent, not a resumed session — a new
process with an empty context that exits when its phase ends.

Nothing is inherited. The only things that cross a phase boundary are files on disk: the handoff
document and the diff. So the agent that writes your code has never seen Jira's tool output, never
seen the parent epic, never seen another subtask, and never seen the branch-naming discussion. It
starts empty and reads one document — the one you wrote.

This is the property the whole design exists to protect. "One context ≈ one engineering task" only
holds if nothing leaks in, and `ctx N%` in the output (below) is how you check that it held.

## Implementation runs your `implement` skill

The implementation phase is not a bespoke prompt pretending to be an engineer. a11yFixer reads
`~/.claude/skills/implement/SKILL.md` at the moment it runs and pastes the body into the prompt,
verbatim, frontmatter stripped:

```
Implement Jira subtask RAD-1001 by following this process, verbatim:

<process>
Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work.

Commit your work to the current branch.
</process>

The work is specified by the handoff at /tmp/…/RAD-1001.handoff.md — …
```

Read at runtime rather than copied into this repository, so it is always the exact skill you
maintain and there is no second copy to drift. Edit the skill, and a11yFixer builds things the new
way on the next run. `/tdd` and `/code-review` are model-invocable skills, so the agent reaches
them from that text exactly as it would in your own session.

The harness adds only the boundaries the skill cannot know about: which branch, which handoff, and
that it must not push, open a PR or touch Jira.

### Where the skill is named, and why it is checked

In `src/claude.ts`, as `IMPLEMENT_SKILL = "implement"`. Resolution mirrors the claude CLI —
`~/.claude/skills/`, then the target repo's `.claude/skills/`, then plugins — so a11yFixer never
needs to know where the skill came from, only that it is really there.

The run refuses to start when no `SKILL.md` resolves, and the subtask fails if the skill disappears
mid-run. Without that check, a missing skill would claim your Jira ticket, run a session with no
process to follow, and look like an ordinary implementation.

The exact prompt each implementer received — skill text included — is saved to
`artifacts/implement-prompt.md`, so "what process did this PR actually follow" is a file you can
open, not a thing you have to trust.

## What it does NOT do

- no discovery, no planning, no ticket triage — that is your half of the work
- no implementing an unlabelled subtask, and no implementing a labelled one with no handoff
- no merging, ever — every PR is a draft and you are the reviewer
- no Jira mutation beyond claiming a subtask. No comments, no resolving, no field edits, and
  nothing is ever moved to Done
- no giant combined PR — one subtask, one branch, one Draft PR
- no shared context between subtasks, or between phases of one subtask
- no concurrency (subtasks run sequentially)
- no hardcoded branch/commit/PR/test conventions: the target repository is the authority

## Jira access is verified, never assumed

Claude Code defers MCP tools when many servers are configured. With ~350 tools available, an
agent that runs a *semantic* `ToolSearch` ("jira atlassian issue") can get nothing back and
conclude Jira is unavailable — then carry on and implement from the issue key alone. That failure
is silent and it makes every downstream result untrustworthy.

Three defences:

1. **Exact tool loading.** Every Jira-touching prompt is given the tool's full name and told to
   load it with an exact select query, which is deterministic:

   ```
   ToolSearch({ query: "select:mcp__claude_ai_Atlassian__getJiraIssue" })
   ```

   `select:` resolves exact names only — keyword searches like `+atlassian` return nothing here —
   so the harness builds the whole write-tool query from the discovered prefix rather than letting
   an agent guess. The first agent reports the tool name it actually used, and that name is
   threaded into every later agent. Override with `--jira-tool <mcp__server__tool>`.

2. **The label filter is the harness's, not the agent's.** The survey agent must report *every*
   direct subtask with the labels Jira actually returned; a11yFixer does the filtering in code.
   That is why the output lists your unlabelled subtasks too — so a typo is something you can see:

   ```
       ✅  RAD-1001  Give video controls accessible names  [To Do]
           RAD-1002  Fix focus order in the transcript panel  [To Do]
               labels: a11y, ready-for-implementaton
   ```

3. **Fetch once, validate, then work from the file.** Before a branch exists, a dedicated session
   transcribes the newest `## Handoff` comment verbatim to `artifacts/<KEY>.handoff.md`. The
   harness checks the result in code: the agent claimed success, the marker heading is present,
   and there is enough text to be a real plan. It retries once, then the subtask fails. Every
   later phase reads that file.

## The one Jira write

Immediately before the implementation agent writes its first line of code, a small dedicated
session claims the subtask:

- assigns it to the Atlassian account your Jira MCP is authenticated as, and
- transitions it to whatever this project's workflow calls its in-progress state.

That is the entire scope of the write. It touches only that subtask, never the parent and never a
linked issue. It does not run in `--dry-run`, and it never runs for a subtask that fails before
implementation starts. If the claim fails it is reported as a warning and implementation continues
— a Jira workflow hiccup should not block engineering work.

## The core principle

**The harness knows the process. You know the plan. The repository knows the policy.**

a11yFixer deliberately knows almost nothing about how your repository expects work to be done.
Its agents discover `AGENTS.md` (root and nested), `CLAUDE.md`, `CONTRIBUTING.md`, READMEs,
testing/accessibility/architecture docs and `.github` templates themselves, and derive the branch
name and PR text *from what they found*. And it knows nothing about what should be built — that is
what your handoff comment is for.

## Requirements

- Node.js 20+
- git
- Claude Code CLI (`claude`) on your PATH
- The `implement` skill installed — from [mattpocock/skills](https://github.com/mattpocock/skills),
  or your own `SKILL.md` at `~/.claude/skills/implement/SKILL.md`
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
| `--label <name>` | the ready label; defaults to `ready-for-implementation` |
| `--model <alias>` | model for every Claude session, e.g. `opus` |
| `--dry-run` | stop each subtask after its handoff is validated and its branch named — no code, no Jira changes, no PR |
| `--allow-missing-token` | skip the `CLAUDE_CODE_OAUTH_TOKEN` check when the machine is already authenticated interactively |
| `--jira-tool <name>` | full MCP tool name for reading Jira; defaults to what the survey agent reports |

Start with `--dry-run`. It proves the Jira connection, shows which subtasks your labels actually
selected, and validates that each one's handoff is readable — without writing code, changing Jira
or touching GitHub. If a label is misspelled or a handoff is missing you find out in about a
minute rather than an hour.

## Terminal output

Long steps show a spinner with a live elapsed timer, so a ten-minute step never looks hung. When
output is piped or redirected the spinner is skipped and each step prints one plain line instead,
so logs stay readable. `Ctrl-C` restores the cursor.

## Cost and context reporting

Every Claude session reports what it used, read straight from the CLI's JSON response — the
harness estimates nothing:

```
   📖  handoff read — 3.4K chars   22s
      └ opus-5  ·  ctx 6% of 1M  ·  ↓ 51.2K  ↑ 0.9K  ·  $0.19
```

with a rollup per subtask and for the whole run:

```
⏱   Wall clock: 1h48m
📊  opus-5   ·   34 Claude sessions   ·   ↓ 6.1M  ↑ 512.4K   ·   $41.02 at list price
    peak context in a single session: 29% of 1M   ·   cache reads 96.3M
```

Three things to read carefully:

- **`ctx N%`** is the largest single turn's prompt divided by the model's context window — the
  fullest that session's context ever got. This is the number that tells you whether the
  one-context-one-task property is actually holding.
- **`↓`** counts fresh tokens only (new input plus cache writes). Cache reads are reported
  separately because summing them across turns counts the same tokens over and over.
- **`$` is list price, not your bill.** On a Claude subscription these calls are covered by your
  plan. Treat the figure as a relative measure of how expensive a subtask was.

## Where things end up

Each run creates `$TMPDIR/a11y-fixer/<repo>-<PARENT>-<timestamp>/<JIRA-KEY>/`:

- `worktree/` — the isolated checkout and branch
- `artifacts/` — `<KEY>.handoff.md` (the handoff every agent worked from),
  `implement-prompt.md` (the exact prompt the implementer got, skill text included), `diff.patch`,
  and the raw JSON from each Claude session

`<KEY>.handoff.md` is the file to open when a PR looks wrong: it is exactly what the agent was
told to build. If it matches what you wrote in Jira, the gap is in the handoff, not the agent.

Worktrees are **never** deleted, including on failure. Clean up with
`git -C <repo> worktree prune` after removing the directories.

## Known limitations

- The implementation phase runs with a shell and no denied tools, because `/implement` runs your
  tests, typecheck and `/code-review` itself. It is confined to a throwaway worktree and is told
  not to push, open a PR or touch Jira — but that boundary is a prompt instruction, not a
  permission. Every other phase has `Bash`, `Edit`, `Write` and `NotebookEdit` denied outright.
- Because `/implement` self-reviews, there is no separate independent-reviewer phase and no
  harness-run verification. The draft PR is the review gate, and it is yours.
- All agents run with `--permission-mode bypassPermissions`. MCP tools are not restricted, so
  "only the claim agent may write to Jira" is enforced by prompt instruction, not by permissions.
- The claim agent picks the in-progress transition by meaning, not by exact name. On an unusual
  workflow it may pick the wrong one, or none — check the `📌`/`⚠️` line in the output.
- Worktrees are clean checkouts with no installed dependencies; `/implement` installs what it
  needs.
- `--tools ""` is deliberately not used to sandbox agents: it removes `ToolSearch`, which is how
  deferred MCP tools (including Jira) get loaded, and silently breaks Jira access.
- Deferred MCP tool schemas cost roughly 50K input tokens in every Jira session, which is most of
  the floor cost of a subtask. `--strict-mcp-config` with a hand-declared Atlassian server would
  fix that, but such a server needs its own OAuth and cannot reuse the claude.ai connector's
  credentials.
- The write-tool name list is specific to the Atlassian MCP server's vocabulary. A different Jira
  MCP server would need that list adjusting; the prefix is discovered, the tool names are not.
