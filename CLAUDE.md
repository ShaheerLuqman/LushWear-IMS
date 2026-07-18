# CLAUDE.md

Coding conventions for this repo — follow them when writing or changing code.

## Comments
- Do **not** write comments that just restate what the code does.
- Only comment when something is non-obvious and matters for review — a gotcha, a
  constraint, a "why it's done this way", or a caveat that isn't visible from the
  code itself.
- Let clear names and structure carry the intent instead of comments.

## Minimal & optimized
- Keep the code as minimal as possible — no dead code, no redundant variables, no
  speculative abstractions.
- Prefer the simplest solution that fully solves the problem.
- Optimize where it counts: avoid needless work, extra passes, and repeated calls;
  push filtering/aggregation to the data source rather than doing it in memory.
- Don't add functionality, config, or options that weren't asked for.

## Consistency
- Match the surrounding code's style, naming, and patterns.
- Reuse existing helpers/utilities instead of reimplementing them.
