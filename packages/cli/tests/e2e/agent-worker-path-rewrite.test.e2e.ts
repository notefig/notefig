import { describe, expect, it } from '@jest/globals';
import { rewriteToWorkspaceRoot } from '../../lib/agent-worker';

describe('rewriteToWorkspaceRoot', () => {
  const browserRoot = '/browser-root';
  const workerRoot = '/Users/x/book';

  it('swaps the browser root prefix for the worker root', () => {
    expect(
      rewriteToWorkspaceRoot(
        `${browserRoot}/.metrists/agent/opencode-t1.json`,
        browserRoot,
        workerRoot,
      ),
    ).toBe(`${workerRoot}/.metrists/agent/opencode-t1.json`);
  });

  it('maps the root itself', () => {
    expect(rewriteToWorkspaceRoot(browserRoot, browserRoot, workerRoot)).toBe(
      workerRoot,
    );
  });

  it('leaves non-matching paths untouched', () => {
    expect(
      rewriteToWorkspaceRoot('/somewhere/else', browserRoot, workerRoot),
    ).toBe('/somewhere/else');
    // A path that merely shares a name prefix but isn't under the root.
    expect(
      rewriteToWorkspaceRoot('/browser-root-other/x', browserRoot, workerRoot),
    ).toBe('/browser-root-other/x');
  });

  it('tolerates trailing slashes on either root', () => {
    expect(
      rewriteToWorkspaceRoot(`${browserRoot}/a`, `${browserRoot}/`, `${workerRoot}/`),
    ).toBe(`${workerRoot}/a`);
  });
});
