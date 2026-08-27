The branch `{{BRANCH_NAME}}` has been created for you in this worktree. You may now implement
Jira subtask {{SUBTASK_KEY}}.

## How to work

- Work ONLY on this Jira subtask.
- Follow the repository instructions you discovered in the previous step. The repository is the
  authority on conventions, architecture, testing and accessibility practice — not your own
  habits and not this prompt.
- Find the ROOT CAUSE. A scanner or ticket reports a DOM symptom; fix the component, pattern or
  primitive that produces it, not just the reported node. If the same defect is produced by a
  shared primitive that this subtask covers, fix it there.
- Prefer repository-native patterns and existing abstractions over new ones.
- For accessibility: prefer semantic HTML over ARIA. Reach for ARIA only when semantics cannot
  express the behaviour. Do not add redundant roles, redundant labels, or `aria-*` attributes
  that duplicate what the element already conveys.
- Reuse design-system primitives where repository guidance indicates that is the right move.
- Add regression coverage where this repository's testing strategy makes that appropriate, in
  the style the repository already uses.
- Keep the change as small as it reasonably can be.

## Hard rules

- Do NOT fix unrelated issues you notice along the way, however tempting.
- Do NOT touch work belonging to linked or related Jira issues.
- Do NOT modify Jira in any way.
- Do NOT commit, push, tag, or open a pull request. The harness owns those side effects.
- Do NOT declare the task globally "done". External deterministic verification runs after you
  stop, followed by an independent review you will not see.

When the implementation is finished, stop and briefly state what you changed and why.
