# Execution walkthrough

> **Stale as of the label-gated refactor.** This document describes the earlier pipeline
> (agent-led discovery, harness-run verification, independent reviewer). The current
> design is in [README.md](../README.md). Regenerate this before presenting it again.

What actually happens, in order, from pressing Enter. Line numbers are real.

```
npm run ship-tickets -- https://…/browse/RAD-85350 --repo ~/results/frontends/microfrontends
```

---

## 0. npm → tsx → cli.ts

`package.json` maps the script to `tsx src/cli.ts`. There is no build step — `tsx` transpiles
TypeScript in memory. Everything after `--` becomes `process.argv`.

**First file opened: `src/cli.ts`.**

Its static imports pull in the whole graph before a line of `main()` runs:

```
cli.ts
 ├── proc.ts      spawn + capture          (leaf)
 ├── git.ts       → proc.ts
 ├── github.ts    → proc.ts
 ├── discovery.ts → claude.ts → proc.ts, usage.ts
 ├── worker.ts    → claude.ts, proc.ts, git.ts, github.ts, discovery.ts, spinner.ts, usage.ts
 ├── report.ts    → worker.ts, spinner.ts, usage.ts
 ├── spinner.ts   (leaf)
 └── usage.ts     (leaf)
```

Every module is side-effect free at import **except `spinner.ts:80-88`**, which registers
`process.on("exit")` and SIGINT handlers so the terminal cursor is always restored.

`cli.ts:230` guards entry, so importing `cli.ts` from a test does not start a run:

```ts
const invokedDirectly = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (invokedDirectly) main().catch(…)
```

---

## 1. main() — `cli.ts:91`

### 1.1 `parseArgs(process.argv.slice(2))` — `cli.ts:31`
Pure function, no I/O, exported so it is unit tested. Returns `Args`. Throws on a bad Jira URL,
a missing `--repo`, or an unknown flag.

### 1.2 `validate(args)` — `cli.ts:69`
Fail-fast preflight, in this order:

| Check | Call | Underlying |
|---|---|---|
| path exists | `stat(repo)` | fs |
| is a git repo | `git.isGitRepo` | `git rev-parse --git-dir` |
| git present | `commandExists("git")` | `command -v git` |
| claude present | `commandExists("claude")` | `command -v claude` |
| token set | `process.env.CLAUDE_CODE_OAUTH_TOKEN` | — |
| gh authed | `github.checkGh` | `gh auth status` |

### 1.3 Freeze the base revision — `cli.ts:97`
```ts
const baseSha    = await git.headSha(repo);        // git rev-parse HEAD
const baseBranch = await git.currentBranch(repo)   // git rev-parse --abbrev-ref HEAD
                ?? await defaultBranch(repo);      // gh repo view --json defaultBranchRef
```
`baseSha` is captured **once** and never re-read. Every subtask branches from this exact commit,
which is what keeps the PRs independent.

### 1.4 Create the run directory — `cli.ts:103`
`$TMPDIR/ship-tickets/<repo>-<PARENT>-<iso-timestamp>/`

---

## 2. Step 0 — prove Jira works — `cli.ts:119`

```
cli.ts:119  checkJiraConnection()
            └── discovery.ts:  renderPrompt("check-jira.md", { JIRA_WRITE_ACCESS })
            └── discovery.ts:  runClaude({ cwd: repo, jsonSchema: CHECK_SCHEMA,
                                           disallowedTools: READ_ONLY_TOOLS })
                └── claude.ts:67  runClaude()
                    └── proc.ts:15 exec("claude", […])   ← child process
            └── discovery.ts:  parseJiraCheck(res.structured, fallbackTool)
```

`readOk` false → `throw` at `cli.ts:143` → caught at `cli.ts:231` → exit 1. Nothing else has run.
`writeOk` false → warn, continue, `jiraAccount = null`.

Returns the exact tool name the agent used, which is threaded into every later prompt.

---

## 3. `runClaude` — the only way a model is ever invoked — `claude.ts:67`

Every one of the 6–7 model calls per subtask goes through this one function.

```ts
claude -p
       --output-format json
       --permission-mode bypassPermissions
       [--resume <session-id>]        // continue an existing context
       [--model <alias>]
       [--disallowed-tools Bash Edit Write NotebookEdit]
       [--add-dir <artifacts>]
       [--json-schema <schema>]
```

Three deliberate details:

- **The prompt goes over stdin**, not argv (`claude.ts:83`) — a 200 KB diff would blow `ARG_MAX`.
- **`--json-schema` forces `structured_output`**, so no regex parsing of prose. `extractJson()`
  at `claude.ts:41` is only a fallback.
- **A session is identified by `session_id` in the response.** Omit `--resume` → new context.
  Pass it → same context. That single flag is the entire context-isolation mechanism.

Two tool policies, `claude.ts:12-13`:

```ts
READ_ONLY_TOOLS     = ["Bash","Edit","Write","NotebookEdit"]  // reviewer, PR-prep, Jira agents
EDIT_NO_SHELL_TOOLS = ["Bash","NotebookEdit"]                 // bootstrap + implementer
```

The implementer can edit files but **cannot run shell commands**. The harness owns execution.

---

## 4. Discovery — `cli.ts:157`

Same shape as Step 0: `renderPrompt` → `runClaude` → `parseDiscovery`.
`parseDiscovery` (`discovery.ts`) normalises keys, drops duplicates, and drops the parent if the
agent included it.

Then the loop, `cli.ts:190`:

```ts
for (const subtask of discovery.subtasks) {
  if (isAlreadyDone(subtask.status)) { push skipped; continue; }
  try   { outcomes.push(await runSubtask(ctx, subtask)); }
  catch { push failed; }          // ← one bad subtask never kills the run
}
```

Sequential, on purpose. `ctx` (`RunContext`) is the only state crossing subtasks: paths,
`baseSha`, `jiraTool`, `jiraAccount`. No model state, ever.

---

## 5. `runSubtask` — `worker.ts:105`

Everything below is one subtask. Local `usage` accumulator at `worker.ts:110`.

| Line | Call | Effect |
|---|---|---|
| `135` | `git.addDetachedWorktree` | `git worktree add --detach <path> <BASE_SHA>` |
| `140` | `fetchSubtaskTicket` | **fresh session** → `artifacts/<KEY>.jira.md`; retries once |
| `149` | `return fail(...)` | **unreadable ticket = subtask over**, before any branch exists |
| `169` | `runClaude` (bootstrap) | **fresh session** → `{ branchName, verificationCommands }` |
| `189` | `git.isValidBranchName` | `git check-ref-format --branch` |
| `192` | `git.branchExists` | `git show-ref --verify` |
| `205` | `git.createBranch` | `git switch -c <branchName>` |
| `215` | `claimSubtask` | **fresh session** → assign + transition. Non-fatal |
| `238` | `runClaude({ resume: implSession })` | **same context as bootstrap** |
| `249` | `git.stageAll` | `git add -A` |
| `250` | `git.changedFiles` | `git diff --cached --name-only <BASE_SHA>` |
| `251` | `return fail(...)` | zero files changed = failure |
| `89`  | `execShell` per command | harness runs the repo's verify commands |
| `266` | `runClaude({ resume: implSession })` | repair, same context, **exactly once** |
| `287` | `git.diffFromBase` | `git diff --cached <BASE_SHA>` → `artifacts/diff.patch` |
| `303` | `runClaude` (review) | **fresh session**, no `resume`, `--add-dir artifacts` |
| `319` | `return fail(...)` | verdict FAIL → no push, no PR |
| `336` | `runClaude` (PR metadata) | **fresh session** |
| `359` | `git.commit` | `git commit -F <file>` |
| `370` | `git.pushBranch` | `git push --set-upstream <remote> <b>:<b>` |
| `381` | `createDraftPr` | `gh pr create --draft --body-file …` |

### Why the diff is computed with `--cached`

`git add -A` then `git diff --cached <BASE_SHA>` compares the base **tree** to the **index**.
That captures new files, and it is correct whether or not the agent committed anything itself.
The same expression works at every stage.

### Sessions per subtask

```
fetch ticket   ── fresh ── dies
bootstrap  ─┐
implement   │  ONE session, resumed twice ── dies
repair     ─┘
claim Jira     ── fresh ── dies
review         ── fresh ── dies      ← never sees the implementer's reasoning
PR metadata    ── fresh ── dies
```

5 distinct contexts, 6–7 process spawns. `implSession` is a `const` local to `runSubtask`;
it is unreachable the moment the function returns.

---

## 6. Failure semantics

`fail()` (`worker.ts:118`) is a closure that stops the spinner, prints, records the worktree path
and returns a `failed` outcome — it **returns**, it does not throw. Throwing is reserved for
harness-level bugs, which `cli.ts:196` catches to keep the loop alive.

Worktrees are never deleted, on success or failure.

---

## 7. `printSummary` — `report.ts`

Partitions outcomes into `pr` / `failed` / `skipped`, prints run totals from the accumulated
`Usage`, and the standing guarantees: nothing merged, linked issues out of scope, worktrees kept.
