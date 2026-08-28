## Execution Economy

Minimize unnecessary context, tool calls, and verification.

1. Scope first.
   Use `rg`, `rg --files`, filenames, symbols, and targeted searches before reading files.
   Do not scan the whole repository unless the task requires it.

2. Read narrowly.
   For large files, read only relevant ranges.
   Do not `cat` large files merely for orientation.

3. Keep command output small.
   For large logs/test output, prefer targeted error matching or bounded tails.
   Do not load thousands of irrelevant output lines into context.

4. Inspect diffs progressively.
   Prefer `git status`, `git diff --stat`, and `git diff --name-only` first.
   Read full diffs only for relevant files.

5. Use the smallest sufficient validation.
   For a localized fix, run the directly relevant test/check once.
   If it passes, stop.
   Run the full test suite only when the change is cross-cutting, high-risk,
   or explicitly requested.

6. Do not perform repeated "safety" reviews after successful validation.
   Do not re-read unchanged files or repeat successful commands without evidence.

7. If a fix fails, re-diagnose from the new evidence.
   Do not repeat the same attempted fix or verification loop.

8. Stay in scope.
   Do not fix unrelated issues, refactor adjacent code, audit the repository,
   or proactively expand the task unless necessary.

9. Use extra tools selectively.
   Do not invoke subagents, expert agents, MCP servers, web search, or skills
   unless they materially help the current task.

10. Stop when done.
    Once the requested behavior is implemented and the necessary validation passes,
    report the result and end the task.
