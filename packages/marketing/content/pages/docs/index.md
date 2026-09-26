---
title: Introduction
description: Notefig is an AI metaharness. Run your agents side by side, right in your documents.
order: 0
---
# Notefig

Notefig is an AI metaharness. It runs the agents you already use (Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Devin, or any agent that speaks ACP) side by side, inside a workspace of plain markdown files.

## How it works

- **Prompt from any document.** Press `/` over a selection and ask. The answer lands in the document, next to the text it's about.
- **Sessions keep going.** Queue follow-ups, switch projects, and come back to finished work. Close the window and your agents carry on.
- **Every change is reversible.** Notefig commits your workspace as you and your agents work, so any edit is one click from undone.

## Try it

This workspace has a few example notes in `notes/`:

- [Q3 kickoff](../notes/q3-kickoff.md): meeting notes to turn into action items
- [Roadmap](../notes/roadmap.md): where those action items land
- [Customer insights](../notes/insights.md): a summary drawn from `notes/interviews/`

Open one, select some text, and press `/` to ask an agent about it. Agents run in the desktop app, or on your own machine with `npx notefig agent`.
