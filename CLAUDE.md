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

## Database migrations
- Schema changes must go through versioned migrations (Supabase migrations or
  Alembic), not hand-edits to `supabase_schema.sql`. The live schema must stay
  reproducible, diffable, and reviewable.

## Modals (frontend)
- A modal's action buttons (Cancel/Save/etc.) must be pinned outside the
  scrolling `.modal-body` — a sibling of it inside `.modal-content`'s flex
  column — using the shared `.modal-pinned-footer` class, not left inside the
  body/form where they scroll away with long content.
- If a `type="submit"` button moves out of its `<form>` this way, give it
  `form="theFormId"` so it still submits that form (see `createLedgerModal`,
  `editLedgerModal`, `changePasswordModal`, `billModal` for the pattern).
- When doing this, check for any JS that finds that button via
  `someForm.querySelector('button[type="submit"]')` (rather than by id) —
  moving the button out of the form breaks that lookup. Prefer explicit ids
  referenced by id everywhere, including in bulk logic like edit-lock toggles.
- A footer needing its own button layout (e.g. a delete button pinned left,
  space-between) composes an existing layout class alongside
  `.modal-pinned-footer` (see `.edit-ledger-actions`) rather than
  reimplementing pinning.
