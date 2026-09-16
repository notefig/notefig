/**
 * Newline framing for child stdio. Both ACP (JSON-RPC, one message per line)
 * and adapter stderr arrive as arbitrarily-chunked byte streams, so every
 * reader needs the same tail-carrying split.
 *
 * Deliberately a copy of the one in ../agent-worker.ts rather than an import:
 * the worker is the byte-pumping path this host supersedes (MET-185 deletes
 * it), so the new code should not grow a dependency on it.
 */
export class LineBuffer {
  private tail = '';

  constructor(private readonly onLines: (lines: string[]) => void) {}

  push(chunk: Buffer | string): void {
    const pieces = (this.tail + chunk.toString()).split('\n');
    this.tail = pieces.pop() ?? '';
    const lines = pieces.filter((line) => line.length > 0);
    if (lines.length > 0) this.onLines(lines);
  }

  /** Emit a trailing fragment left unterminated by a closing stream. */
  flush(): void {
    if (this.tail.length > 0) {
      const line = this.tail;
      this.tail = '';
      this.onLines([line]);
    }
  }
}
