# a11yFixer

Discovery is yours. Implementation is the agent's.

You decide what should be built and write it down. a11yFixer picks up the subtasks you marked,
runs **your `implement` skill** against each one in an isolated agent, and opens a Draft PR.

## The contract

For each Jira subtask you want built:

1. Grill it — `/grilling`, or however you like to think it through.
2. Paste the conclusion into the subtask as a **comment**, under a `## Handoff` heading.
3. Label the subtask **`ready-for-implementation`**.

That comment is the spec. Not the description, not the summary, not the agent's own plan. An
unlabelled subtask is ignored; a labelled one with no `## Handoff` comment fails immediately
rather than guessing:

```
❌  RAD-85351 failed after 38s
   handoff unusable: no `## Handoff` heading in the returned text.
```

## Pipeline

```
parent Jira issue
  └─ direct subtasks labelled `ready-for-implementation`, minus any already in flight
       ├─ fresh claude session ── fetch each `## Handoff` comment verbatim → file
       ├─ fresh claude session ── plan the order, and what stacks on what
       └─ then for each, in that order:
            harness              ── git worktree from its base (BASE_SHA, or what it stacks on)
            fresh claude session ── branch name from repo conventions
            harness              ── create branch
            fresh claude session ── claim Jira: assign to you + In Progress
            fresh claude session ── YOUR implement skill (/tdd, typecheck, /code-review, commit)
            fresh claude session ── PR title + body from repo conventions
            harness              ── git push + gh pr create --draft
```

Every box is a **separate `claude -p` process** with an empty context. Nothing is inherited; the
only things crossing a boundary are files on disk. The agent writing your code has never seen
Jira's tool output, the parent epic, another subtask, or the branch-naming discussion — it reads
one document, the one you wrote.

## Order and stacking

Handoffs are fetched and validated **before** anything is claimed or built, because the order
depends on what they say. A planning session then reads them and returns the sequence, plus what
each subtask must be built on top of — the handoff's own words if it names a dependency, otherwise
whatever creates a shared primitive before the work that consumes it.

Independent subtasks branch from the frozen `BASE_SHA` and their PRs target the base branch. A
subtask that depends on another starts from **that branch's head**, and its PR targets that branch:

```
BASE_SHA
 ├── a11y/RAD-1001   PR #1 → main
 │    └── a11y/RAD-1002   PR #2 → a11y/RAD-1001    (contains RAD-1001's code)
 └── a11y/RAD-1003   PR #3 → main
```

So dependent work genuinely builds on earlier work, and each PR still shows only its own diff —
`git diff` is taken from that subtask's own base, not from `BASE_SHA`. The cost is a forced merge
order: merge #1 before #2. If a subtask fails, everything stacked on it is skipped as *stranded*
rather than quietly rebuilt from the base branch without the dependency it was planned to have.

The harness owns this: a dependency the planner points at a subtask that has not been built yet,
at itself, or at nothing is dropped, and a subtask the planner forgets is still built, unstacked.

## Which subtasks are skipped

- not labelled `ready-for-implementation`
- labelled, but the status says someone is already on it — In Progress, In Development, Code
  Review, In Review, In Verification, QA, Testing, Done, Closed, Resolved, Cancelled. Only
  not-started work is a candidate; an unrecognised status is treated as available.
- labelled and available, but carrying no `## Handoff` comment — that one is a **failure**, not a
  skip
- stranded behind a subtask that failed

## What it uses to implement

Nothing of its own. At the moment the implementation phase starts, a11yFixer reads your skill file
and pastes its body into the prompt:

```
Implement Jira subtask RAD-1001 by following this process, taken verbatim from the
`implement` skill at /Users/you/.claude/skills/implement/SKILL.md:

<process>
Implement the work described by the user in the spec or tickets.
Use /tdd where possible, at pre-agreed seams.
Run typechecking regularly, single test files regularly, and the full test suite once at the end.
Once done, use /code-review to review the work.
Commit your work to the current branch.
</process>

The work is specified by the handoff at /tmp/…/RAD-1001.handoff.md — …
```

Three consequences worth knowing:

- **The agent never looks a skill up.** It is handed the text, so there is no name to guess at and
  no lookup to resolve wrongly. Edit the skill, and the next run builds the new way — the text is
  read at runtime, never copied into this repository.
- **No skill, no run.** If no `SKILL.md` resolves, a11yFixer refuses to start, before any worktree,
  branch or Jira write. A second check catches it disappearing mid-run.
  ```
  ❌  a11yFixer: the `implement` skill is not installed.
    a11yFixer does not implement anything itself — it runs that skill.
    Install it from https://github.com/mattpocock/skills, or drop a SKILL.md at
    ~/.claude/skills/implement/SKILL.md
  ```
- **`/tdd` and `/code-review` are model-invocable skills**, so the agent reaches them from that
  text exactly as it would in your own session. They must be installed too.

## Requirements

- Node.js 20+, git, `gh` (authenticated)
- Claude Code CLI on PATH, plus `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`)
- The `implement`, `tdd` and `code-review` skills — [mattpocock/skills](https://github.com/mattpocock/skills)
- Jira MCP (Atlassian) connected in Claude Code
- A target repository whose `AGENTS.md` is actually useful — every prompt defers to it for branch,
  commit, PR, testing and accessibility conventions

## Run

```sh
npm install
npm run a11y-fixer -- https://you.atlassian.net/browse/RAD-85350 --repo ~/path/to/repo --dry-run
```

| flag | meaning |
| --- | --- |
| `--repo <path>` | target repository (required) |
| `--label <name>` | ready label; default `ready-for-implementation` |
| `--model <alias>` | model for every session, e.g. `opus` |
| `--dry-run` | validate handoffs and name branches, then stop — no code, no Jira writes, no PR |
| `--allow-missing-token` | skip the token check when the machine is already authenticated |
| `--jira-tool <name>` | full MCP tool name for reading Jira, if your server is named differently |

Start with `--dry-run`: it proves Jira works, shows which subtasks your labels actually selected,
and validates every handoff — in about a minute.

## Paths

**Skill resolution** — `findSkill()` mirrors the claude CLI, first match wins:

```
~/.claude/skills/<name>/SKILL.md
<target repo>/.claude/skills/<name>/SKILL.md
~/.claude/plugins/*/*/*/*/skills/<name>/SKILL.md
```

**Prompts** — `prompts/*.md` are templates, not prompts. `renderPrompt()` (`src/claude.ts:91`)
substitutes `{{VARS}}`, and the caller supplies them from real data:

```ts
// src/worker.ts:107
const branchPrompt = await renderPrompt("branch-name.md", {
  SUBTASK_KEY: subtask.key,          // "RAD-1001", from the Jira survey
  SUBTASK_SUMMARY: subtask.summary,
});

// src/worker.ts:166
const implementPrompt = await renderPrompt("implement.md", {
  IMPLEMENT_SKILL: await readSkillBody(skillPath),  // the skill file's text
  SKILL_PATH: skillPath,                            // where it was read from
  HANDOFF_PATH: handoffPath, BRANCH_NAME: branchName, …
});
```

The agent never sees `{{…}}`. Prompts total ~500 words: they say what the job is and defer to
`AGENTS.md` for how. Anything the repository already documents was deleted.

**Run output** — `$TMPDIR/a11y-fixer/<repo>-<PARENT>-<timestamp>/<JIRA-KEY>/`:

| file | what it answers |
| --- | --- |
| `artifacts/<KEY>.handoff.md` | what the agent was told to build |
| `artifacts/branch-name.json` | the branch convention it found, and where |
| `artifacts/implement-prompt.md` | the exact prompt it got, skill text included |
| `artifacts/diff.patch` | what it produced |
| `artifacts/*.json` | raw response from each session, with token and cost data |
| `worktree/` | the isolated checkout and branch |

Worktrees are never deleted, including on failure. Clean up with `git -C <repo> worktree prune`.

## Limits

- The implementation phase gets a shell and no denied tools, because your skill runs its own
  tests and `/code-review`. It is confined to a throwaway worktree and told not to push, open a PR
  or touch Jira — a prompt instruction, not a permission. Every other phase has `Bash`, `Edit`,
  `Write` and `NotebookEdit` denied outright.
- No harness-run verification and no separate reviewer: your skill self-reviews, and the draft PR
  is the human gate.
- Jira MCP tools are deferred in Claude Code, and a *semantic* tool search silently returns
  nothing — so every Jira prompt is handed an exact `select:` query instead. The tool name the
  first agent actually used is threaded into all the others.
- One Jira write, ever: assign + move to In Progress, on the subtask being implemented. Never on
  the parent, never to Done. Failure there is a warning, not a stop.
- Subtasks run sequentially, and stacked ones must be merged in order. Nothing is ever merged
  by a11yFixer.
