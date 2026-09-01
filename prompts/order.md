Order these Jira subtasks for implementation, and say which one each must be built on top of.

{{SUBTASKS}}

Read every handoff — each is the agreed spec for its subtask. If a handoff states the order or
names a dependency, that is the answer. Otherwise decide from the work itself: whatever creates a
shared component, primitive or utility comes before the subtasks that consume it.

Return `order`: every key exactly once, in implementation order, each with a one-line `reason` and
`dependsOn` — the key it builds on, or null. `dependsOn` must appear earlier in the list. Prefer
null: a dependency forces its subtask's pull request to target the other's branch instead of the
base branch, so claim one only when the later work genuinely needs the earlier code.
