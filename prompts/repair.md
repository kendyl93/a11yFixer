External deterministic verification was run against your implementation of {{SUBTASK_KEY}} and
it FAILED. This is your one and only repair attempt.

## Failures

{{FAILURES}}

## What to do

Fix ONLY your implementation for this same Jira subtask so that these commands pass, while the
change still genuinely solves the Jira task.

- Read the failure output carefully before editing. Fix the cause of the failure.
- If a test you added is wrong, fix the test. If the production change is wrong, fix the
  production change.
- Do NOT weaken, skip, delete or `.skip` an existing test to make it pass.
- Do NOT disable a lint rule, suppress a type error, or silence a scanner instead of fixing the
  underlying problem, unless the repository's own documented conventions explicitly allow it.
- Do NOT broaden scope. Do NOT modify unrelated code.
- Do NOT modify Jira. Do NOT commit or push.

When you have made the fix, stop and state briefly what you changed.
