---
name: create-ticket
description: Draft and file a Linear ticket (MET team) that is implementation-ready — enforces the full structure: idea/why, technical notes with architectural boundaries and new concepts, manual testing implications, automated tests, and user-story + technical-story acceptance criteria. Use whenever the user asks to create, write, or file a ticket/issue.
---

# Create Ticket

Produce a ticket complete enough that someone can pick it up and implement it with little to no additional discovery. A ticket that just names a feature is not done — every section below must be filled in with real, codebase-grounded content.

## Process

1. **Understand the request.** If the scope, motivation, or rough approach is unclear, ask before drafting. Do not invent roadmap rationale.
2. **Research the codebase first.** Before writing technical notes, read the relevant code (entities in `src/entities/`, existing services, related components). Technical notes must reference real files, modules, and patterns — not hypothetical ones. Check `docs/architecture/` for relevant plans.
3. **Draft the ticket** using the exact structure below. Show it to the user for review before filing unless they asked you to file directly.
4. **File it in Linear** with `mcp__linear-server__save_issue` on the MET team (load the tool via ToolSearch). Title: short, imperative, no prefix. Body: the full markdown from the template. Attach to the relevant project if one exists.

## Required ticket structure

Every ticket body uses exactly these sections, in this order. None may be omitted; if a section genuinely doesn't apply (e.g. no new concepts), state that explicitly ("None — reuses existing X") rather than deleting the section.

```markdown
## Overview

<What this is, in 2–4 sentences, and **why it is on the roadmap** — the user
or product problem it solves, and what it unblocks. Link related tickets.>

## Technical Notes

<Detailed implementation guidance. This is the core of the ticket — write it
so an implementer needs little further discovery. Must cover:>

### Architectural boundaries
<Which layers/modules this touches and which it must NOT touch. Where the
seams are: e.g. "goes through the `agents` facade, never talks to ACP
directly", "reads via entities layer, no direct fs access". Name real files
and modules.>

### New entities & concepts
<Any new entity, collection, service, protocol message, or domain concept
being introduced. For each: name, shape (fields/types), where it lives, and
how it relates to existing concepts. "None" is a valid answer — say so.>

### Implementation sketch
<The intended approach, step by step or component by component. Key
functions/files to add or change. Known edge cases and how to handle them.
Decisions already made (and why), vs. decisions left to the implementer.>

## Manual Testing

<How a human verifies this works: concrete steps to exercise the feature in
the running app, states to check, and anything that needs special setup
(fixtures, auth, a second workspace, etc.). Include regression-prone
adjacent flows to spot-check.>

## Automated Tests

<The specific tests to write: unit/integration/e2e, what each asserts, and
where they live relative to existing test structure. Name the behaviors
that must be covered, not just "add tests".>

## Acceptance Criteria

### User stories
<Checklist of user-visible outcomes: "As a <role>, I can <action> and see
<result>." Each must be independently verifiable.>

- [ ] ...

### Technical stories
<Checklist of technical outcomes: invariants held, boundaries respected,
tests passing, no regressions. E.g. "All fs access goes through entities
layer", "New collection is reactive and survives reload".>

- [ ] ...
```

## Quality bar

Before filing, verify:

- **Implementation-ready**: could a competent contributor unfamiliar with this feature start coding from the ticket alone? If any section would force them to come back and ask "but how/where?", it's not done.
- **Grounded**: every file, module, and pattern named in the technical notes actually exists (or is explicitly marked as new).
- **Boundaries explicit**: the ticket says what the change must not touch, not only what it touches.
- **Testable**: every acceptance criterion is a checkbox someone can objectively verify.
- **Scoped**: if the draft grows beyond what one person can implement in a reasonable stretch, propose splitting it into multiple tickets and ask the user.
