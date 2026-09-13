/**
 * Terminal rendering for streamed ACP session updates. Agent text is the
 * content; everything else is a one-line marker, so a turn reads as prose
 * rather than a protocol dump. Unrecognized kinds print their name instead of
 * being swallowed — this is a diagnostic surface.
 *
 * A dispatch table rather than a switch: each kind's rendering is independent,
 * and adding one should not make a single function harder to read.
 */
import * as chalk from 'chalk';

/** Where rendered output goes; injectable so tests don't need a terminal. */
export type UpdateSink = {
  /** Mid-line write, for streamed text chunks. */
  write(text: string): void;
  /** Whole-line write, for markers. */
  line(text: string): void;
};

export const consoleSink: UpdateSink = {
  write: (text) => process.stdout.write(text),
  line: (text) => console.log(text),
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Update = any;

function chunkText(update: Update): string | null {
  const text = update.content?.text;
  return typeof text === 'string' ? text : null;
}

const RENDERERS: Record<string, (update: Update, out: UpdateSink) => void> = {
  agent_message_chunk: (update, out) => {
    const text = chunkText(update);
    if (text !== null) out.write(text);
  },
  agent_thought_chunk: (update, out) => {
    const text = chunkText(update);
    if (text !== null) out.write(chalk.gray(text));
  },
  tool_call: (update, out) => {
    out.line(chalk.cyan(`\n  → ${update.title ?? update.kind ?? 'tool call'}`));
  },
  tool_call_update: (update, out) => {
    if (update.status === 'failed') out.line(chalk.yellow('  ! tool call failed'));
  },
  plan: (_update, out) => out.line(chalk.gray('\n  [plan updated]')),
};

/** Render one `session/update` notification. */
export function renderSessionUpdate(
  notification: unknown,
  out: UpdateSink = consoleSink,
): void {
  const update = (notification as Update)?.update;
  if (!update) return;
  const render = RENDERERS[update.sessionUpdate as string];
  if (render) render(update, out);
  else out.line(chalk.gray(`\n  [${update.sessionUpdate}]`));
}
