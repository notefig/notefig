/**
 * Minimal ambient types for `node:sqlite`, used only by `db-conformance.test.ts`.
 * The repo runs Node 22, where the module needs no flag, but `@types/node` is
 * pinned at ^20 and predates it. Delete this when that moves to 22+.
 */
declare module "node:sqlite" {
  interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  class StatementSync {
    /** Allows `$1` to bind as the bare named parameter `1`. */
    setAllowBareNamedParameters(allow: boolean): void;
    run(namedParameters?: Record<string, unknown>): StatementResultingChanges;
    all(namedParameters?: Record<string, unknown>): Record<string, unknown>[];
  }

  export class DatabaseSync {
    constructor(location: string);
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }
}
