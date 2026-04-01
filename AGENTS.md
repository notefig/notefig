# Metrists Monorepo - AI Agent Guidelines

## Repository Structure

This is a monorepo containing the Metrists CLI and Desktop applications, along with shared code.

```
packages/
├── cli/              # CLI package (published to npm as 'metrists')
├── desktop/          # Desktop app (Tauri + React, published as binaries)
├── shared/           # Internal shared package (not published)
│   ├── src/
│   │   ├── types/    # Shared TypeScript types
│   │   ├── utils/    # Utility functions
│   │   ├── parsing/  # Markdown/content parsing
│   │   └── validation/  # Zod schemas
│   └── package.json
└── themes/           # Theme packages
```

## Package Management

- **Tool**: npm workspaces
- **Node version**: 18+ (check `.nvmrc`)
- **Install all dependencies**: `npm ci` at root

## Key Commands

```bash
# Build all packages
npm run build

# Development
npm run dev:cli          # CLI in watch mode
npm run dev:desktop      # Desktop dev server

# Testing
npm run test             # All tests
npm run test:cli         # CLI tests only
npm run test:desktop     # Desktop unit tests only

# Linting
npm run lint             # All packages
npm run lint:cli         # CLI only
```

## Shared Package Usage

When adding code that both CLI and Desktop need:

1. Add to `packages/shared/src/` in appropriate folder
2. Export from `packages/shared/src/index.ts`
3. Import in CLI/Desktop: `import { something } from "@metrists/shared"`

Example:
```typescript
// packages/shared/src/parsing/markdown.ts
export function parseMarkdown(content: string) { ... }

// packages/shared/src/index.ts
export * from "./parsing/index.js";

// In CLI or Desktop
import { parseMarkdown } from "@metrists/shared";
```

## Release Process

Both CLI and Desktop have **independent, manual releases**:

### CLI Release
1. Go to GitHub Actions → "Release CLI Package"
2. Click "Run workflow"
3. Enter version (e.g., `0.8.0`)
4. Workflow creates:
   - Commit bumping version
   - Tag: `cli-v0.8.0`
   - GitHub Release
   - npm publish

### Desktop Release
1. Go to GitHub Actions → "Release Desktop App"
2. Click "Run workflow"
3. Enter version (e.g., `0.0.40`)
4. Workflow creates:
   - Commit bumping version
   - Tag: `desktop-v0.0.40`
   - GitHub Release with binaries
   - Cloudflare Pages deployment

### Tagging Convention
- CLI: `cli-v{semver}` (e.g., `cli-v0.7.4`)
- Desktop: `desktop-v{semver}` (e.g., `desktop-v0.0.40`)

This prevents conflicts and allows independent versioning.

## CI/CD Workflows

All workflows are in `.github/workflows/`:

- `ci-tests.yml` - Runs on every PR/push to main/develop
  - Tests CLI, Desktop unit tests, Desktop Tauri tests
  - Lints CLI and shared package

- `release-cli.yml` - Manual trigger for CLI releases

- `release-desktop.yml` - Manual trigger for Desktop releases

## Adding Dependencies

### To a specific package:
```bash
cd packages/cli
npm install some-package
```

### To shared (available to both):
```bash
cd packages/shared
npm install some-package
```

Both CLI and Desktop already have `@metrists/shared` as a dependency.

## TypeScript Configuration

- Shared package uses `composite: true` for project references
- Both CLI and Desktop can import from shared without additional tsconfig changes
- Build shared first: `npm run build:shared`

## Testing

Tests run automatically on PRs via GitHub Actions. Test files:
- CLI: `packages/cli/**/*.test.ts` (Jest)
- Desktop: `packages/desktop/**/*.test.ts` (Vitest)
- Desktop E2E: `packages/desktop/tests/e2e/` (Playwright)

## Important Notes

1. **Desktop package name changed**: Was `metrists`, now `@metrists/desktop` (private)
2. **CLI package name unchanged**: Still `metrists` (published to npm)
3. **Shared is private**: Never publish `packages/shared/`
4. **Always build shared first** before building CLI or Desktop
5. **Desktop workflow untouched**: The release logic is identical, only file location changed

## Migration from Old Structure

If you see references to:
- `packages/cli/.github/workflows/` - Moved to root, now deleted
- Manual npm publish from root - Use `release-cli.yml` workflow instead
- Desktop as `metrists` package - Now `@metrists/desktop`
