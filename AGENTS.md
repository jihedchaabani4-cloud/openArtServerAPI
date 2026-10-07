## Project rules
- Before any task, read docs/plan/00_CORE.md and the phase file the human names. The plan files win over any Spec Kit file.
- One commit per task. Failing test first. Full hermetic `npm test` before every commit (no .env, no network, no real DB).
- Secrets scan on `git diff --cached` before every commit.
- Use the structured logger, never console.*. Never log secrets, tokens or prompts.
- Never push, tag, merge, or edit anything under my-app/.
- Every id from a client must be ownership-checked and project-scoped. Cross-tenant access returns 404, never 403.
- Additive migrations only. Never rename existing tables, columns, classes or routes.

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
at specs/033-prompt-bar-platform/plan.md
<!-- SPECKIT END -->
