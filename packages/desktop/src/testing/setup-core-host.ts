/**
 * Vitest setup: give every suite a configured core.
 *
 * `getServiceHost()` throws when unconfigured — the behavior we want in
 * production, where that means a boot-order bug. In tests the composition
 * root never runs, so a host is installed here instead.
 *
 * ## Why this doesn't just install `desktopHost`
 *
 * It did, first, and it broke a third of the suite. `desktopHost` statically
 * imports `@/adapters`, so a setup file that imports it resolves the *real*
 * platform adapter before any test's `vi.mock("@/adapters")` can take
 * effect, and drags enough of the app graph along to blow the stack.
 *
 * So the members are reached lazily instead. `editor.adoptWrite` resolves
 * `desktopEditorContext` through a dynamic import at call time, which means
 * the module registry is whatever the test file set up — mocks included —
 * and suites that never write a file never load the editor stack at all.
 *
 * The real desktop editor context is what gets used, deliberately: suites
 * like `file-sync-workspace-fs.test.ts` mount actual editors and assert an
 * agent write is adopted into them, and a detached context would turn those
 * assertions into silent no-ops rather than failures.
 */
import { beforeEach } from "vitest";
import {
  configureCore,
  detachedEditorContext,
  type ServiceHost,
} from "@notefig/core";
import { posix } from "@notefig/shared/utils";

/** Reached only if a test exercises a core path that needs it — at which
 *  point the message says what to do instead of failing obscurely. */
function unavailable(surface: string): never {
  throw new Error(
    `the test host has no ${surface} surface; mock "@/adapters" in the suite that needs it`,
  );
}

const testHost: ServiceHost = {
  platform: {
    get fs(): never {
      return unavailable("fs");
    },
  },
  capabilities: { runsInBackground: false },
  path: posix,
  telemetry: { captureEvent: () => undefined },
  translate: (key) => key,
  appDirName: ".notefig",
  editor: {
    // Mirrors `desktopEditorContext` exactly: real write half, read
    // projections still detached until the read cut lands. `attached` stays
    // false because it describes the reads, and claiming otherwise here
    // would make the test host disagree with the host it stands in for.
    ...detachedEditorContext,
    async adoptWrite(absolutePath, content, persist) {
      const { desktopEditorContext } = await import(
        "@/adapters/editor-context"
      );
      return desktopEditorContext.adoptWrite(absolutePath, content, persist);
    },
  },
};

beforeEach(() => {
  configureCore(testHost);
});
