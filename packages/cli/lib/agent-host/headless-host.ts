/**
 * The CLI's implementation of `ServiceHost` — the first non-desktop one, and
 * the reason the contract is worth trusting.
 *
 * A host contract with no implementations is an inventory, not a boundary:
 * the first draft of `ServiceHost` declared telemetry, i18n and an app
 * directory name while omitting both things this host actually does (build a
 * file system and build a transport), and nothing caught it because nothing
 * had to satisfy it. This file is what makes that failure mode impossible.
 *
 * What is honestly missing is stated as such rather than stubbed silently:
 * there is no `db` (no durable store in the CLI yet) and the editor is
 * detached. Both are declared shapes the core can branch on, not surprises.
 */
import * as os from 'os';
import { posix, win32 } from '../shared';
import {
  detachedEditorContext,
  type ServiceHost,
} from '../core';
import { createNodeFileSystem } from './node-fs';
import { createNodeProcess } from './node-process';

/** `.notefig` — the per-workspace directory both hosts agree on. */
const APP_DIR_NAME = '.notefig';

export type HeadlessHostOptions = {
  /** Diagnostics sink; the CLI routes this to its verbose logger. */
  onDiagnostic?: (line: string) => void;
};

export function createHeadlessHost(
  options: HeadlessHostOptions = {},
): ServiceHost {
  return {
    platform: {
      fs: createNodeFileSystem(),
      proc: createNodeProcess(),
      // No `db`: the CLI has no SQLite store yet. Declared absent rather
      // than faked, so a core that needs persistence fails with a sentence
      // instead of writing into a bucket nobody reads.
    },

    capabilities: {
      // A CLI invocation is the foreground. When the process exits, the work
      // stops — the service process (MET-185) is what flips this to true.
      runsInBackground: false,
    },

    // Same decision the desktop makes, from the same signal.
    path: os.platform() === 'win32' ? win32 : posix,

    telemetry: {
      // No PostHog in the CLI. Events become verbose diagnostics so a run
      // can still be traced, without the CLI acquiring a consent question it
      // has no way to ask.
      captureEvent: (name, properties) =>
        options.onDiagnostic?.(
          `telemetry ${name}${properties ? ` ${JSON.stringify(properties)}` : ''}`,
        ),
    },

    // No i18n bundle here: the CLI is English-only. Returning the key is the
    // honest identity translation — it is what the user sees, and it is
    // greppable when a real bundle arrives.
    translate: (key) => key,

    appDirName: APP_DIR_NAME,

    // Nothing is on screen. Editor-backed tools still exist and still
    // answer; they answer "no editor attached".
    editor: detachedEditorContext,
  };
}
