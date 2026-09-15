import { StringDecoder } from 'node:string_decoder';

/**
 * Newline framing for child stdio. Both ACP (JSON-RPC, one message per line)
 * and adapter stderr arrive as arbitrarily-chunked byte streams, so every
 * reader needs the same tail-carrying split.
 *
 * One copy, imported by both the agent host and the agent worker. They had
 * byte-identical private copies, which is fine until one of them is fixed —
 * and two were: the concat below was quadratic, and `chunk.toString()` split
 * multi-byte characters across chunk boundaries.
 *
 * **Why fragments instead of a growing tail.** The obvious implementation
 * does `(tail + chunk).split('\n')` on every chunk. ACP frames one JSON-RPC
 * message per line and a tool result or `fs/read_text_file` response runs to
 * megabytes, while a pipe delivers 64KB at a time — so a 20MB message meant
 * ~320 concatenations averaging 10MB, some gigabytes of copying and seconds
 * of blocked event loop for a single message. Holding the fragments and
 * joining once, when a newline actually arrives, makes that linear.
 *
 * **Why StringDecoder.** A UTF-8 character can straddle a chunk boundary;
 * `Buffer.prototype.toString` on each chunk independently corrupts it. The
 * decoder carries the partial code point across pushes.
 *
 * **Why lines arrive as a batch.** `onLines` takes an array, which is a
 * tunnel-side economy the worker depends on (unrelated to the desktop's pull
 * streams in src-tauri/src/line_stream.rs — WebSocket frames don't have the
 * desktop's eval-path hazards): a streaming agent emits many lines per stdout
 * chunk, and sending one tunnel frame each costs an encryption pass and a
 * WebSocket frame apiece. A chunk's lines are already in hand, so coalescing
 * them adds no latency and needs no timer.
 */
export class LineBuffer {
  private readonly decoder = new StringDecoder('utf8');
  /** Pieces of the line currently being assembled, joined only on newline. */
  private pending: string[] = [];

  constructor(private readonly onLines: (lines: string[]) => void) {}

  push(chunk: Buffer | string): void {
    const text =
      typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (text.length === 0) return;

    if (!text.includes('\n')) {
      // No line ends in this chunk: keep the piece and copy nothing.
      this.pending.push(text);
      return;
    }

    const pieces = (this.takePending() + text).split('\n');
    const tail = pieces.pop() ?? '';
    if (tail.length > 0) this.pending.push(tail);
    const lines = pieces.filter((line) => line.length > 0);
    if (lines.length > 0) this.onLines(lines);
  }

  /** Emit a trailing fragment left unterminated by a closing stream. */
  flush(): void {
    const rest = this.takePending() + this.decoder.end();
    if (rest.length > 0) this.onLines([rest]);
  }

  private takePending(): string {
    if (this.pending.length === 0) return '';
    const joined = this.pending.join('');
    this.pending = [];
    return joined;
  }
}
