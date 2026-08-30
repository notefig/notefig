/**
 * Test-only helpers, published as `@notefig/widgets/testing`. Kept out of the
 * package's main entry so `vitest` never reaches an application bundle.
 */
export {
  EMPTY_ROUND,
  fakePromptWidgetHost,
  withHost,
} from "./fake-host";
