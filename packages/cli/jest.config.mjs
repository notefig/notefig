export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/.metrists/'],
  // Two tiers: the long-standing `*.e2e.ts` suites, and `tests/**/*.test.ts`
  // unit/integration specs (scoped to tests/ so the nested fixture projects
  // under .metrists/ and test-audio/ can't contribute stray matches).
  testMatch: ['**/?(*.)+(e2e).[jt]s?(x)', '<rootDir>/tests/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/.metrists/'],
  moduleNameMapper: {
    // Resolve @notefig/agent the way the published CLI does: to the vendored
    // CJS bundle esbuild produces (see esbuild.config.mjs). The package's own
    // exports point at ESM TypeScript source, and its ACP dependency is
    // ESM-only, so neither Node nor ts-jest can require it directly — the
    // bundle is the only loadable form, and testing against it means the
    // packaging itself is under test. Run `npm run build` first — the same
    // convention the e2e specs already rely on to exec dist/bin/notefig.js.
    '^@notefig/agent$': '<rootDir>/dist/lib/agent.js',
    // Same for @notefig/shared, since it carries the persistence layer: the
    // bundle is where TanStack DB's ESM-only dependency has been converted to
    // CommonJS. Required unbundled, it fails to load under Jest (and on Node
    // older than 20.19 / 22.12).
    '^@notefig/shared$': '<rootDir>/dist/lib/shared.js',
  },
};
