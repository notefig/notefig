# @notefig/ui

The shadcn/Radix primitives and the `cn` helper, shared by the desktop app and
`@notefig/widgets`.

Leaf components only — nothing here may reach into an application. Two
primitives deliberately did *not* move and still live in the desktop app,
because they depend on it: `Markdown` (renders through the app's conversion
worker and platform opener) and `Toaster` (reads the app's theme provider).
Components in other packages that need those take them as props — see the
`slots` field on `PromptWidgetHost`.

Source-only: this package ships `.tsx` and is resolved through the workspace
aliases in `packages/desktop/vite.shared.ts`. There is no build step beyond a
typecheck.
