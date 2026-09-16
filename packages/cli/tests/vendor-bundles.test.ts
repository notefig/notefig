/**
 * The vendored bundles must not carry duplicate copies of a workspace
 * package.
 *
 * `dist/lib/{shared,agent}.js` are emitted separately, and esbuild will
 * happily inline a workspace dependency into each one unless told to reuse
 * the sibling. That shipped for real: `@notefig/agent` imports
 * `@notefig/shared` (and its `/agent` and `/utils` subpaths), so agent.js
 * carried a whole second copy of shared — two `BlobParseError`s, two
 * `BlobPatchError`s, two `FrameCipher`s in one process.
 *
 * Nothing throws one of those across the boundary today, which is why the
 * duplication was invisible: the failure mode is a future `instanceof` that
 * is false for no visible reason. This asserts the structure instead of
 * waiting for that.
 *
 * Reads build output, so it needs `npm run build -w packages/cli` first —
 * the same precondition the rest of this suite already has through its
 * moduleNameMapper onto dist.
 */
import { describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(__dirname, '..', 'dist', 'lib');
const read = (name: string) => readFileSync(join(DIST, `${name}.js`), 'utf8');

/** A distinctive private symbol from @notefig/shared. If it appears in a
 *  bundle other than shared.js, that bundle inlined its own copy. */
const SHARED_ONLY_SYMBOL = 'ID_PREFIXES';

describe('vendored bundles', () => {
  it('emits the sibling bundles', () => {
    for (const name of ['shared', 'agent']) {
      expect(existsSync(join(DIST, `${name}.js`))).toBe(true);
    }
  });

  it('keeps exactly one copy of @notefig/shared', () => {
    expect(read('shared')).toContain(SHARED_ONLY_SYMBOL);
    expect(read('agent')).not.toContain(SHARED_ONLY_SYMBOL);
  });

  it('reaches shared through the sibling bundle rather than inlining it', () => {
    expect(read('agent')).toContain('require("./shared.js")');
  });
});
