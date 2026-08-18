/**
 * MUST be the first import of the marketing entry: forces the pure
 * IndexedDB fs adapter (an already-supported escape hatch in
 * `shouldUseBrowserFsAdapter`) before anything touches the module-eval
 * `platformAdapter` singleton. The marketing site's workspace is seeded,
 * not picked, so the File System Access adapter is never wanted here.
 */
(window as unknown as { __NOTEFIG_FORCE_INDEXEDDB__: boolean }).__NOTEFIG_FORCE_INDEXEDDB__ =
  true;

export {};
