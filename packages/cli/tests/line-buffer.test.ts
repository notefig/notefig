/**
 * The framing both the agent host and the agent worker depend on. It had two
 * byte-identical private copies, each with the same two defects; this covers
 * the fixes so a future copy cannot quietly reintroduce them.
 */
import { describe, expect, it } from '@jest/globals';
import { LineBuffer } from '../lib/line-buffer';

function collect(): { lines: string[]; buffer: LineBuffer } {
  const lines: string[] = [];
  const buffer = new LineBuffer((batch) => lines.push(...batch));
  return { lines, buffer };
}

describe('LineBuffer', () => {
  it('splits on newlines and carries the tail across chunks', () => {
    const { lines, buffer } = collect();

    buffer.push('one\ntw');
    expect(lines).toEqual(['one']);

    buffer.push('o\nthree\n');
    expect(lines).toEqual(['one', 'two', 'three']);
  });

  it('delivers a chunk’s lines as one batch', () => {
    const batches: string[][] = [];
    const buffer = new LineBuffer((batch) => batches.push(batch));

    buffer.push('a\nb\nc\n');

    expect(batches).toEqual([['a', 'b', 'c']]);
  });

  it('emits an unterminated trailing fragment on flush', () => {
    const { lines, buffer } = collect();

    buffer.push('no newline here');
    expect(lines).toEqual([]);

    buffer.flush();
    expect(lines).toEqual(['no newline here']);
  });

  it('does not corrupt a UTF-8 character split across chunks', () => {
    // The old implementation called chunk.toString() per chunk, so a
    // multi-byte character straddling a boundary decoded as two replacement
    // characters. An agent writing non-ASCII hit this on any 64KB boundary.
    const { lines, buffer } = collect();
    const bytes = Buffer.from('héllo — wörld\n', 'utf8');

    for (let i = 0; i < bytes.length; i++) {
      buffer.push(bytes.subarray(i, i + 1));
    }

    expect(lines).toEqual(['héllo — wörld']);
    expect(lines[0]).not.toContain('�');
  });

  it('assembles a multi-megabyte line from many chunks', () => {
    // ACP frames one JSON-RPC message per line and a large tool result runs
    // to megabytes over 64KB pipe chunks. The old `tail + chunk` concat made
    // this quadratic; this asserts the result is still exact.
    const { lines, buffer } = collect();
    const chunk = 'x'.repeat(64 * 1024);
    const count = 64; // 4MB

    for (let i = 0; i < count; i++) buffer.push(chunk);
    buffer.push('\n');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(chunk.length * count);
  });
});
