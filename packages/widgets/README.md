# @notefig/widgets

Custom ProseMirror nodes that carry their own markdown form and render as
interactive chrome rather than as prose.

Start at [`src/define-widget.ts`](src/define-widget.ts) — it states the shape
every widget here conforms to, and why. In short:

1. **Two halves.** A worker-safe `base` (schema + markdown spec) and a
   renderer `view` that extends it with a node view and plugins. Sharing one
   base is what guarantees the markdown conversion worker and the live editor
   parse and serialize identically.
2. **The codec is pure.** A widget that persists to markdown owns one
   Tiptap-free module over plain strings.
3. **Nothing impure is imported.** Everything a widget cannot compute from its
   own document reaches it through one typed host object.

The AI prompt widget (`src/prompt/`) is the reference implementation. Its host
contract is [`src/prompt/host.ts`](src/prompt/host.ts); the application
implements it in `packages/desktop/src/components/agent/prompt-widget-host.tsx`
and installs it with `PromptWidgetHostProvider`.

## Using it from an editor

```ts
import { widgetSchemaNodes, widgetRendererNodes } from "@notefig/widgets";

// Worker / codec: schema + markdown only, no React, no host.
widgetSchemaNodes();

// Renderer: scoped to one document.
widgetRendererNodes({ filePath, basePath });
```

Wrap anything that renders a widget — including your own components that reuse
`PromptEditor` — in `PromptWidgetHostProvider`.

## Testing

`@notefig/widgets/testing` exports `fakePromptWidgetHost()` and `withHost()`.
Standing a widget up should take one object and no module mocks; if you find
yourself adding a `vi.mock`, the leak it patches over probably belongs in the
host contract instead.

## Strings

The UI resolves i18n keys the **host application** defines. `PROMPT_WIDGET_I18N_KEYS`
lists every one, and the app asserts it defines them all — keep the list in
sync when adding or removing a `t()` call.
