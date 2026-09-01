/implement Jira subtask {{SUBTASK_KEY}} in this repository, exactly as agreed in the handoff document below.

## The handoff IS the specification

A human engineer already interrogated this work, made every design decision, and wrote the result
up. That document is at:

    {{HANDOFF_PATH}}

Read it in full before you touch anything, and implement what it says — every point in it, and
nothing outside it. It supersedes your own plan, your own instincts about the problem, and any
description you may find on the Jira issue ({{SUBTASK_URL}}). Where the handoff is silent, the
repository's own conventions decide; where they are silent too, keep the change small and obvious.

If the handoff contradicts itself or is missing something you genuinely cannot proceed without,
stop and say so plainly at the end of your turn. Do not invent the missing decision — a human
made these decisions on purpose.

## Your working environment

- You are in a fresh git worktree, checked out at `{{BASE_SHA}}`, on branch `{{BRANCH_NAME}}`,
  which was created for you. Stay on it.
- Nothing has been installed or built here yet.
- The repository is the authority on conventions, architecture, testing and accessibility
  practice — not your habits and not this prompt. Read its `AGENTS.md` / `CLAUDE.md` /
  `CONTRIBUTING.md` and follow their pointers before you write code.

## Accessibility

- Fix the ROOT CAUSE. A scanner reports a DOM symptom; fix the component, pattern or primitive
  that produces it, not just the reported node — as far as, and no further than, the handoff says.
- Prefer semantic HTML over ARIA. Reach for ARIA only when semantics cannot express the behaviour,
  and never add roles or `aria-*` attributes that duplicate what the element already conveys.
- Reuse this repository's design-system primitives where its guidance says that is the right move.

## Hard rules

- Do NOT fix unrelated issues you notice along the way, however tempting.
- Do NOT weaken, skip, delete or `.skip` a test, disable a lint rule, or suppress a type error to
  get to green. Fix the cause.
- Do NOT modify Jira in any way.
- Do NOT push, tag, or open a pull request. Commit to `{{BRANCH_NAME}}` and stop there — the
  harness pushes and opens a draft PR after you finish, and a human reviews it.
- When you run `/code-review`, review against `{{BASE_SHA}}`, and act on what it finds before you
  finish.

When you are done, state briefly what you changed and why, and flag anything a human reviewer
must check by hand.
