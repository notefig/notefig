# 01 — The markdown editor (port spec)

Spike slice: the document editor. It describes what exists today in the Tauri/React app (Tiptap 3.30 / ProseMirror) precisely enough to rebuild it without reading the TypeScript. It then covers what a native Rust/GPUI port needs and what it costs.

**Decision recorded:** the user chose **Option A**, a faithful ProseMirror-compatible model with a custom GPUI view (§5.0). The platform spike recommends forking `wabzqem/gpui-kit-markdown-editor` as the base (§5.1a). Reusing Zed's GPL editor code is acceptable to the user (§5.2).

Source of truth: `/Users/parsa/Documents/notefig-gpui` at `4a6555c1` (main, after the perf-SLO PR #505). Perf commits from the stacked `parsa-perf-combined` branch (PR #506) are cited by hash where they matter. Paths below are relative to `packages/`.

Agents/harness, git/history and the app shell have their own spikes. This spec defines only the interfaces where they touch the editor (§3.2.6, §2.5–2.7, §5.8).

---

## 0. One-page summary

- **Stack.** Tiptap 3.30 (ProseMirror model 1.25, transform 1.12, view 1.41, state 1.4, tables 1.8, history 1.5). Markdown goes through `tiptap-markdown` 0.9 in three steps:
  1. markdown-it 14 renders **markdown → HTML**.
  2. ProseMirror's DOMParser reads **HTML → doc**.
  3. prosemirror-markdown 1.13's `MarkdownSerializerState` writes **doc → markdown**.

  Because the round trip passes through a DOM, it causes every quirk listed below.
- **The file is the source of truth; the editor is a projection of it.** Autosave fires 500 ms after typing stops. External and agent writes are *diffed into* the open editor as one transaction (`recreateTransform`), never applied as a wholesale `setContent`. This preserves carets, widget drafts and the identity of untouched nodes.
- **Custom syntax** (all of it round-trips):
  - YAML frontmatter: a hidden node, edited in a popover.
  - Prompt-widget markers: `<!-- notefig:prompt id="blob_…" task="task_…" -->`.
  - Diff blocks: ` ```ts diff ` fences holding a unified diff.
  - underline/highlight/sub/sup, written as inline HTML (`<u>`, `<mark>`, `<sub>`, `<sup>`).
  - `- [ ]` task items, including empty ones.
  - Mentions, written as `@relative/path`.
- **There is no classic slash menu or floating menu.** Typing `/` summons the **AI prompt widget**. It is the product's centerpiece:
  - An interactive block node whose *draft text is document content* but is never written to disk.
  - It renders as a block card driven by a 5-state machine.
  - It talks to the agents layer through a host interface.
  - It tracks the edits its agent rounds made and shows them as gutter bars.
- **The agent contract leaks ProseMirror positions.** `document_read_range` and the widget-context resource address documents in PM integer positions. Option A must reproduce PM position arithmetic exactly (§2.8).
- **Port verdict (Option A chosen).** About **40–48 person-weeks to MVP** and **70–85 to parity** when built from scratch. Forking gpui-kit-markdown-editor should shave the model, transform, history, input-rule, table and IME rows of §5.6. That has not been verified in this spike.
- **Biggest risks:**
  - Rich-text layout and hit-testing in GPUI.
  - IME.
  - Platform text services that WKWebView gives for free: spellcheck, autocorrect, Writing Tools, accessibility.
  - Editable holes inside node views (the prompt draft).
  - A byte-exact markdown serializer.
  - wasm support.

---

## 1. Inventory: schema, extensions, markdown forms

### 1.1 Where the schema is defined

- `desktop/src/components/editor/editor-schema-kit.ts`: `createSchemaExtensions()` is the single, worker-safe list of everything that affects the schema or the markdown round trip. The markdown codec (worker) and the live editor both build from it, so their output is byte-identical by construction.
- `desktop/src/components/editor/tiptap-editor-kit.tsx`: adds React node views and UI-only extensions on top (`editorExtensions`).
- `desktop/src/components/editor/editor-store.ts` (`createMarkdownInstance`): swaps the image, codeBlock and widget nodes for per-document configured instances. It also adds `PageLinkSuggestion`, `widgetMinimapExtension` and `dictationExtension`.
- `widgets/src/registry.ts`: `editorWidgets = [promptWidget]` is the only widget registry. `widgetSchemaNodes()` returns the worker-safe halves and `widgetRendererNodes()` the live halves.

**Extension order matters** (it affects schema construction and the order hooks run in):

1. StarterKit, with `codeBlock`, `link`, `underline`, `listItem` and `document` turned off.
2. DocWithFrontmatter.
3. PromptHostListItem.
4. AutoDirection.
5. FrontmatterMarkdown (Markdown).
6. Underline, Subscript, Superscript, Highlight, Link.
7. MarkdownTaskList, MarkdownTaskItem.
8. Image.
9. Table, TableRow, TableCell, TableHeader.
10. CodeBlock (DiffCodeBlock).
11. The widgets (PromptDraft, mention, aiPrompt).
12. Frontmatter. It must come after Markdown.

The live editor then adds Placeholder, CharacterCount, NativeFormatIntercept, NativeHistoryFocusGuard and the per-document extensions.

StarterKit 3.x parts that stay enabled: Blockquote, Bold, Code, BulletList, OrderedList, ListKeymap, HardBreak, Heading, HorizontalRule, Italic, Paragraph, Strike, Text, Dropcursor, Gapcursor, TrailingNode, UndoRedo (prosemirror-history).

### 1.2 Top-level content expression

```
doc         := frontmatter? block+
listItem    := (paragraph | aiPrompt) block*            # PromptHostListItem, widened for "/" in lists
taskItem    := (paragraph | aiPrompt) paragraph*        # nested:false → no sub-lists in task items
aiPrompt    := promptDraft                              # group block, isolating, allowGapCursor:false
promptDraft := (text | mention | hardBreak)*            # marks:"" (no marks), isolating, NOT in group block
frontmatter := atom, not in group block, admitted only at doc position 0
```

`LEADING_BLOCK` is built from the widgets with `inlineHostable: true` (`widgets/src/define-widget.ts`). A new summonable widget therefore widens both list contents automatically.

### 1.3 Nodes

"Out" is the serializer: prosemirror-markdown defaults, wrapped by tiptap-markdown, plus our overrides. "In" is markdown-it plus the `updateDOM` hooks.

| Node | Source | Attrs | Markdown out | Markdown in | Input rules / keys | Notes |
|---|---|---|---|---|---|---|
| `doc` | `DocWithFrontmatter` (schema-kit) | — | blocks joined by blank lines | — | — | replaces stock `block+` |
| `paragraph` | StarterKit | — | inline text, blank line after | `<p>` | `Mod-Alt-0` | CSS `unicode-bidi: plaintext` (per-block RTL) |
| `text` | StarterKit / tiptap-markdown | — | `escapeHTML` (`<`→`&lt;`, `>`→`&gt;`), then `esc()`, which backslash-escapes `` ` * \ ~ [ ] _ `` (not intra-word `_`). At line start it also escapes `+ `, `-`, `*`, `>`, `#{1-6} `, `1. `. | — | — | **Lossy:** a literal `<` becomes `&lt;` on disk |
| `heading` | StarterKit | `level` 1–6 | ATX `# …` | ATX and setext | `^#{1,6}\s` → heading; `Mod-Alt-1..6` | setext normalizes to ATX once |
| `blockquote` | StarterKit | `dir="auto"` (static) | `> ` prefix | `>` | `^\s*>\s$`; `Mod-Shift-b` | |
| `bulletList` | StarterKit | `tight` (tiptap-markdown), `dir` | `- ` items (`bulletListMarker:"-"`); tight lists have no blank lines | `-`, `*`, `+` | `^\s*([-+*])\s$`; `Mod-Shift-8` | `*` and `+` bullets normalize to `-` |
| `orderedList` | StarterKit | `start`, `tight`, `dir` | `N. ` with right-aligned numbers; an adjacent second list uses `N) ` | `1.` / `1)` | `^(\d+)\.\s$`; `Mod-Shift-7` | renumbers from `start` |
| `listItem` | `PromptHostListItem` | `dir` | via the list | `<li>` | Enter splits; Tab/Shift-Tab sink/lift (ListKeymap); Backspace at start lifts | content widened to admit `aiPrompt` |
| `taskList` | `MarkdownTaskList` | `tight` (custom: `data-tight` or no `<p>`) | like bulletList: `- [ ] …` | markdown-it-task-lists (`.contains-task-list`) | `Mod-Shift-9` | stock tiptap-markdown always wrote loose lists; this fixes it |
| `taskItem` | `MarkdownTaskItem` (`nested:false`) | `checked`, `dir` | `[x] text` / `[ ] text`; an empty item writes `[ ]` with **no trailing space** | plugin items, plus a fallback that converts an `li` whose text is exactly `[ ]`/`[x]`/`[X]` | `^\s*(\[([( \|x])?\])\s$` | checkbox is a real `<input>` in a label; flex row |
| `codeBlock` | `DiffCodeBlock` (`widgets/src/diff-block/schema.ts`) | `language`, `diff:boolean` | ```` ```{lang\|("text" if diff)}{" diff"?}\n{text}\n``` ```` | markdown-it fence; the `diffFences` core rule sets `data-diff` when the info string has `diff` after the language | ```` ^```([a-z]+)?[\s\n]$ ````, `~~~` likewise; `Mod-Alt-c`; Enter ×3 or ArrowDown at end exits | `updateDOM` strips the fence's trailing `\n`. Language picker and highlighting are decorations (§3.6) |
| `horizontalRule` | StarterKit | — | `---` | `---` / `***` / `___` | `^(?:---\|—-\|___\s\|\*\*\*\s)$` | |
| `hardBreak` | StarterKit / tiptap-markdown | — | `\` + newline (`<br>` inside tables) | `  \n` or `\` + newline | `Shift-Enter`, `Mod-Enter` | the two-space form normalizes to `\` once; trailing hard breaks are dropped |
| `image` | `MarkdownImageBase` (block, `allowBase64`) | `src`, `alt`, `title` | `![alt](src "title")`, with `()` escaped in src, then **`closeBlock`** (it is a block) | `<img>` | `(?:^\|\s)(!\[(.+\|:?)]\((\S+)(?:(?:\s+)["'](\S+)["'])?\))$` | an inline image mid-paragraph **splits the paragraph** (normalizes once). Node view in §3.3 |
| `table` | `@tiptap/extension-table` (`resizable:true`) + tiptap-markdown | (`colwidth` on cells) | GFM pipe table **only if** row 1 is all `tableHeader`, no other row has headers, there are no col/rowspans, and every cell has ≤ 1 child. **Otherwise the whole table is written as raw HTML.** | GFM pipe table | Tab/Shift-Tab between cells; table menu (§4.5) | **Lossy:** column widths are never written; a cell keeps only its first block's inline content; alignment (`:---:`) is dropped |
| `tableRow`, `tableCell`, `tableHeader` | tiptap | `colspan`, `rowspan`, `colwidth`; cells have `dir` | via table | | | cell content is `block+` |
| `frontmatter` | `FrontmatterNodeBase` (schema-kit) + hidden node view | `yaml` (raw text, no fences) | `---\n{yaml}\n---` then closeBlock; **empty yaml writes nothing** | `splitFrontmatter`: line 0 is `---` (after trimEnd) and a later line is `---`; one blank line after the closing fence is eaten. Handed to the PM parser as `<div data-type=frontmatter data-yaml=URI-encoded>` | none (atom, not selectable or draggable) | §3.4 |
| `aiPrompt` | `widgets/src/prompt/node.ts` | `summoned`, `blobId`, `taskId`, `reference` | unbound: **nothing**; bound: `<!-- notefig:prompt id="…" task="…" -->` | `updateDOM` walks childNodes for comment nodes matching the sentinel and turns them into `div[data-type=ai-prompt]`; a repeated `id` is dropped | `/` summon (§3.2.2) | §3.2. `renderHTML` carries no attrs, so copying never clones identity |
| `promptDraft` | `PromptDraftNodeBase` | — | no-op (never reached) | `div[data-type=prompt-draft]` | many (§3.2.5) | the composer text, as document content |
| `mention` | `widgets/src/prompt/composer/mention-node.ts` (`@tiptap/extension-mention`) | `id` (relative path), `label` | `@{relativePath}` | never parsed from markdown; comes back as text | `@` suggestion inside drafts | **Lossy by design:** a chip pasted outside a draft round-trips to plain text |

### 1.4 Marks

| Mark | Out | In | Rules / keys |
|---|---|---|---|
| `bold` | `**…**` | `**` / `__` | `**x**`, `__x__`; `Mod-b` |
| `italic` | `*…*` | `*` / `_` | `*x*`, `_x_`; `Mod-i`. `_x_` normalizes to `*x*` |
| `strike` | `~~…~~` (expels enclosing whitespace) | `~~` | `~~x~~`; `Mod-Shift-s` |
| `code` | `` `…` `` (backtick count adapts to the content) | backticks | `` `x` ``; `Mod-e` |
| `link` | `[text](href "title")` | `[..](..)`; linkify **off** | `openOnClick:false`, `autolink:false`, `linkOnPaste:false`. No effective input rule. Edited through the modal and the bubble menu (§4.6) |
| `underline` | `<u>…</u>` (needs `html:true`) | inline HTML | `Mod-u` |
| `highlight` | `<mark>…</mark>` | inline HTML | `==x==` input and paste rule; `Mod-Shift-h` |
| `subscript` | `<sub>…</sub>` | inline HTML | `Mod-,` |
| `superscript` | `<sup>…</sup>` | inline HTML | `Mod-.` |

The HTML marks serialize through tiptap-markdown's `markdownHTMLMark`: it renders a one-space fragment and extracts the opening and closing tags.

### 1.5 Behaviour-only extensions (no schema)

| Extension | Where | What it does |
|---|---|---|
| UndoRedo (prosemirror-history) | StarterKit | `Mod-z`, `Mod-Shift-z`, `Mod-y`. Groups edits by `newGroupDelay` (500 ms default). Meta `addToHistory:false` excludes a transaction (§2.7) |
| Dropcursor, Gapcursor | StarterKit | drop indicator; a caret between blocks where there is no text. `aiPrompt.allowGapCursor=false` |
| TrailingNode | StarterKit | keeps an empty paragraph after a trailing non-paragraph block |
| ListKeymap | StarterKit | Backspace/Delete at list edges, `Mod-Backspace`/`Mod-Delete` |
| AutoDirection | schema-kit | static `dir="auto"` global attr on lists, list items, blockquote and cells (`parseHTML` always returns "auto"). Paragraphs and headings use CSS `unicode-bidi: plaintext` instead; the earlier per-block decorations cost ~25 ms a keystroke on 8k lines (532b4b55) |
| FrontmatterMarkdown | schema-kit | subclass of `Markdown` that wraps `parser.parse` with `splitFrontmatter`. Applies to full parses only; inline parses (paste) are untouched |
| Markdown clipboard | tiptap-markdown | `transformPastedText:true`: pasted **plain text is parsed as markdown** (inline mode) unless Shift is held. `transformCopiedText:false`: copy writes PM's HTML plus `textBetween` plain text, not markdown |
| Placeholder | kit | empty doc or empty block shows "Type something, or press / for AI…". Empty for `promptDraft`, because the widget paints its own |
| CharacterCount | kit | registered but **nothing reads it** (dead code; drop it in the port) |
| NativeFormatIntercept | kit | WKWebView context-menu `beforeinput format*` events become toggleBold/Italic/Underline/Strike; other `format*` events are swallowed |
| NativeHistoryFocusGuard | kit, priority 1000 | browser `historyUndo`/`historyRedo` aimed at a hidden tab's contenteditable is swallowed unless that view has focus |
| PageLinkSuggestion | `widgets/src/page-link.ts` | `@` in prose (outside drafts and code) opens the file popup and inserts link text `name` (`.md` dropped) with `href = pageLinkHref(...)`, followed by an unmarked space |
| widgetMinimapExtension | `widgets/src/minimap/*` | a rail of dots, one per widget, pinned top-right of the scroller (§3.2.8) |
| dictationExtension | `widgets/src/dictation/extension.ts` | push-to-talk target. In-progress text shows as a ghost decoration; the final text is inserted in one transaction (§3.8) |
| codeHighlight, codeLanguagePicker, codeDiff | `widgets/src/{code-highlight,code-language}.ts*`, `diff-block/extension.ts` | §3.5–3.6 |
| prompt plugins | `widgets/src/prompt/{node-view,interactions,change-tracking,change-gutter}.ts*` | §3.2 |
| DragHandle (React) | `text-editor.tsx` | §4.3 |

### 1.6 Custom on-disk syntax (complete list)

1. **Frontmatter:** `---\n<yaml>\n---\n\n` at byte 0.
   - CRLF fences are recognized.
   - An unclosed opening fence, or a `---` mid-document, is a horizontal rule.
   - Bare `---\n---` normalizes away.
2. **Prompt marker:** `<!-- notefig:prompt id="[A-Za-z0-9_-]+" task="[A-Za-z0-9_-]+" -->` on its own block.
   - Codec: `widgets/src/prompt/marker-codec.ts` (`serialize`, `parse`, `parseData`, `strip`).
   - `stripPromptMarkers` drives emptiness checks (the untitled-scratchpad sweep).
   - Ids are minted as `blob_<base36 time><rand>` (`doc-helpers.ts:newPromptBlobInstanceId`) and `task_…`.
3. **Diff block:** the info string has `diff` among the words after the language (```` ```ts diff ````). A lone ```` ```diff ```` is the diff *language*, not a diff block.
   - Body: a one-file unified diff (`--- a/x`, `+++ b/x`, `@@ -s,c +s,c @@`). See `widgets/src/diff-block/syntax.ts`.
   - Agents get `DIFF_BLOCK_GUIDE`. `patchOf()` builds a block from before/after text (npm `diff` `createTwoFilesPatch`, plus a hunk line shift).
   - A diff block with no language serializes as ```` ```text diff ````.
4. **Inline HTML marks:** `<u>`, `<mark>`, `<sub>`, `<sup>`.
5. **Mentions:** `@relative/path` as plain text. Only composers parse them back to chips (`draft-text.ts`): multi-word candidates are probed longest first, gated by an extension dot or end of line, at most 16 words.
6. **Directives:** `@namespace:value` (e.g. `@model:opus`). They exist only in drafts and composers and never reach the file (§3.7).

### 1.7 Lossy and normalizing round trips

These are known and tested in `desktop/src/components/editor/__tests__/markdown-roundtrip.test.ts`. The contract has two parts:

- Canonical input is an **identity**: `serialize(parse(md)) === md`.
- Non-canonical input **normalizes once to a fixed point**.

Behaviours by category:

- **Normalized once:**
  - `*` and `+` bullets become `-`.
  - `_em_` becomes `*em*`; `__b__` becomes `**b**`.
  - Setext headings become ATX.
  - A trailing-two-space hard break becomes `\`.
  - Ordered lists are renumbered.
  - Tight and loose lists keep their state (`tight`).
  - An inline image splits its paragraph.
  - A missing blank line after the frontmatter fence is added.
- **Dropped:**
  - HTML comments other than prompt markers. A `<!-- … -->` note is silently deleted on the first save.
  - Unknown HTML elements (`<div>`, `<details>`, `<span style>`) are unwrapped; their text survives.
  - Table column widths and alignment.
  - Cell content beyond the first block.
  - Link reference definitions. markdown-it resolves them, so they become inline links.
  - Footnotes and definition lists. markdown-it core has no footnotes, so they stay as literal text.
  - A literal `<` or `>` in text is written back as an entity.
  - Trailing whitespace. The serializer never writes a final newline; `isExternalContentChange` and `needsAdoption` compare with `trimEnd()`.
  - HTML entities typed literally (`&nbsp;`) decode to characters on parse.
- **Written as HTML:** non-GFM-shaped tables, and any node without a markdown spec (tiptap-markdown's `markdownHTMLNode` falls back to `getHTMLFromFragment`). Mention and frontmatter define specs precisely to avoid this.
- **Not editable as markdown:** any text file other than `.md`, `.markdown`, `.mdown`, `.mkd`, `.txt` or `.text` opens in the read-only code viewer (`desktop/src/modules/editors/editor-type.ts`), because the codec would rewrite it.

> **Port implication.** Existing user files have converged to this canonical form. A Rust serializer must reproduce the same behaviour byte for byte, or the first save after the port churns every file (and every git diff). That means matching:
> - prosemirror-markdown's escaping
> - list indentation: `renderList` uses `maxW+2` spaces for ordered lists and 2 for bullets
> - the tight/loose logic
> - `closeBlock` blank lines
> - mark open/close ordering, including mark nesting and whitespace expulsion
> - code-fence backtick widening

---

## 2. Markdown ↔ document pipeline

### 2.1 Codec

`desktop/src/components/editor/markdown-codec.ts`: `createMarkdownCodec()` returns `{parse(md) → JSON, serialize(JSON) → md, hash(md) → MD5}`. It builds the tiptap-markdown parser and serializer against a *fake editor* (a schema plus the extension list), so no view is needed. The MD5 matches the Rust watcher (`desktop/src/utils/hash.ts`).

**Parse:**

1. `FrontmatterMarkdown`'s wrapped `parser.parse` splits off the frontmatter.
2. markdown-it runs with `{html:true, linkify:false, breaks:false}`. Each extension's `parse.setup(md)` installs its plugins: markdown-it-task-lists 2.1, `diffFences`, and the code-block `langPrefix`.
3. `md.render` produces an HTML string, and `elementFromString` turns it into a DOM.
4. Each extension's `parse.updateDOM(element)` adjusts the DOM: task-item normalization, prompt-marker comments turned into divs, and the fence's trailing `\n` stripped.
5. `normalizeDOM` lifts block elements out of `<p>` and drops markdown-it's `\n` after elements outside `<pre>`.
6. `innerHTML` is passed to `createNodeFromContent(html, schema, {slice:false})`. That is ProseMirror `DOMParser.parse`, driven by each node's `parseHTML` rules.

**Serialize:** a tiptap-markdown subclass of `MarkdownSerializerState` (it adds `inTable` and delimiter-run trimming), using the node and mark specs from each extension's `storage.markdown.serialize`. Unknown nodes and marks fall back to HTML.

**Where it runs:**

- In the markdown worker, `desktop/src/workers/markdown-codec.worker.ts`, with a linkedom DOM shim (`worker-dom-shim.ts`).
- `desktop/src/utils/markdown-conversion.ts` exposes `parseMarkdown`, `serializeDoc` and `renderMarkdown`, and falls back to the main thread if the worker dies.
- The same worker renders chat markdown (`desktop/src/utils/markdown-html.ts`: `html:false, linkify:true, breaks:true`, plus `drawnDiffFences`, which wraps diff fences in `<notefig-diff-block>`).

### 2.2 Load path

1. A tab opens. `PolymorphicEditor` (`desktop/src/components/editor/polymorphic-editor.tsx`) picks the editor type with `getEditorType`: `image`, `markdown` or `code`.
2. `openDocument(path, content, hash)` parses in the worker. The promise is cached per path and content, and the call sets the `DocumentSync` baseline.
3. `getOrCreateEditor(editors, path, {type:"markdown", content: docJSON, basePath, prompts, dictation}, fs)` builds an `Editor` (`editor-store.ts`). It **throws** on empty content, so an empty doc can never be autosaved over a real file.
4. Instances are cached in `core.editors` (`desktop/src/modules/editors/editors.ts`), keyed by absolute path. They **outlive the React mount**: the dock mounts only the selected tab, so editor state (doc, selection, history) survives tab switches. A `MarkdownInstance` carries `savedSelection` and `savedViewport`.
5. Tab close calls `disposeEditor`: it flushes the debounce, calls `destroy()`, then `closeDocumentSync`.

### 2.3 Save path (editor → disk)

`desktop/src/components/editor/use-editor-file-sync.ts` and `markdown-conversion.ts:DocumentSync`.

1. The editor fires `update`. It is **ignored** when:
   - `suppressSaveRef` is set (during adoption);
   - the content has not loaded yet;
   - the transaction has meta `uiOnlyNodeChange` (`UI_ONLY_TRANSACTION_META`: keeper, trailing paragraph, gap repair);
   - the transaction has meta `notefig-external-adoption`;
   - `isDraftOnlyEdit(tr)` is true, meaning every step range is inside an `aiPrompt` (`desktop/src/components/editor/draft-only-edit.ts`). Drafts never serialize, so saving would only churn the watcher. Skipping these also keeps the debounce window clear, so a user typing a prompt does not block agent writes.
2. After a **500 ms** debounce, `sync.pushUpdate(() => doc.toJSON())` runs. The snapshot is taken lazily.
3. `DocumentSync.runSaveLoop`:
   - At most one serialize-and-write is in flight. Updates that arrive meanwhile set `dirty` and collapse into one fresh snapshot (backpressure, no timers).
   - `generation` is bumped on adoption, so a serialization of a replaced doc is discarded.
   - It records `lastMarkdown` and `lastHash`.
   - `writer = files.file(path).write(markdown)`, which updates the content collection row before disk (rows lead disk).
   - `whenClean()` is used before moves and closes.
   - On error it logs and re-runs any dirty edits.
4. `flushPendingEdits` is wired so `disposeEditor` can push out the debounce window *before* `destroy()`.

### 2.4 External changes (disk → editor): differential adoption

The watcher updates the content row (`contentHash`, `content`), and the effect in `useEditorFileSync` runs:

1. **`sync.needsAdoption(hash, content)`** returns false when there is no baseline yet, when the hash is unchanged, or when `lastMarkdown.trimEnd() === content.trimEnd()` (in that case it just records the hash).
2. **Currency checks.** Adoption is skipped:
   - for a stale render: the row must still be `files.collections.content.get(path).contentHash`, checked both before *and* after the async parse;
   - when `saveTimerRef` is set (a debounce is pending);
   - when `prepareAdoption` returns null because the sync is `saving || dirty`.

   In all these cases **the user's edit wins** (last writer wins) and their save overwrites the external change.
3. **`adoptExternalContent(editor, docJSON, {source:{path, contentHash, attribute}})`** (`desktop/src/components/editor/adopt-external-content.ts`):
   1. `carryDraftsForward(incoming, oldDoc)` copies each live widget's draft into the incoming widget with the same `blobId`.
   2. Build `newDoc` and `check()` it. If it is invalid, or if `old.nodeSize + new.nodeSize > 400_000`, use the fallback.
   3. Diff with `recreateTransform(oldDoc, newDoc, {complexSteps:true, wordDiffs:true, simplifyDiff:true})`. This is vendored at `desktop/src/vendor/prosemirror-recreate-transform/recreateTransform.ts` (442 LOC, Apache-2.0). It diffs the doc JSON with rfc6902 to get ReplaceSteps, then refines text with `diffWordsWithSpace`. Steps are applied with `maybeStep`; a failure switches to the fallback.
   4. **Widget re-assertion** (`restoreDroppedWidgets` in `widgets/src/prompt/doc-helpers.ts`): every `aiPrompt` in the old doc that is missing from the new one is re-inserted at `tr.mapping.map(oldPos)`.
      - Unbound widgets are never in the file, so they are always re-asserted.
      - This is why agents that rewrite whole files without the markers cannot delete widgets.
      - Policy seam: `resolveDroppedWidget` returns `"reinsert"`; an "orphan" path is stubbed.
   5. **Draft-caret restore:** if the caret was inside a draft, it goes back to the same widget (matched by node identity or `blobId`) at the same offset, clamped.
   6. Tag the transaction with `ADOPTION_TRANSACTION_META`. Add `PROMPT_CHANGE_META = {blobId, turnId}` when `turnWrites.attribute(path, hash)` names a round. Dispatch exactly **one** transaction.
   7. **Fallback:** one `setContent` chain with the same widget re-assertion (positions scaled proportionally) and caret restore.
4. **`sync.commitAdoption(content, hash)`** bumps `generation`, clears dirty and sets the baseline. If `reinsertedWidgets > 0`, `pushUpdate` writes the markers back.

### 2.5 Agent writes (`core.documents`)

`desktop/src/modules/documents/documents.ts`, built by `createDocuments({fs, openFiles, editors, attribute})`.

- **`read(path, {line, limit})`** reads **from disk** (1-based ACP lines), not from the live editor. Edits still in the debounce window are invisible to `fs/read_text_file`. Only the widget-context resource and `document_read_range` read the live doc (§2.8).
- **`write(path, content)`:**
  1. Assert the path is absolute.
  2. If a move of the path is pending (`beginMove`), wait for it and retarget.
  3. Serialize per path (an `inFlight` promise chain).
  4. Write to disk, then `updateLoadedRows` in every open workspace (the watcher echo is consumed natively).
  5. If an editor is open: `prepareAdoption`, then `adoptExternalContent` (attributed), then `commitAdoption`. If widgets were re-asserted, serialize the editor and rewrite the file *inside* the same tracked write.
- **`whenWritesSettled(path)`** and **`beginMove(path) → {settle(finalPath)}`** are used by tab rename and scratchpad promotion.

### 2.6 Turn-write attribution (`core.turnWrites`)

`desktop/src/modules/turn-writes/turn-writes.ts` listens to `agent:tool-call` and `agent:turn-settled`. It keeps two facts per path:

- **in flight:** the mutating tool calls (`isMutatingToolCall`);
- **written:** the content hash read back when a call settled, plus its task and turn.

`attribute(path, hash)` checks for an exact hash match in `written` first, then falls back to the latest in-flight call. It then maps the call to the widget watching that round (`promptWidgets.findByTask(taskId, turnId)`) and returns `{blobId, turnId}` or null. Nothing is persisted.

### 2.7 Undo / history

- **Editor undo** is prosemirror-history.
  - **Excluded** (`addToHistory:false`): keeper insertion, trailing-paragraph repair, gap-cursor repair, code-highlight refresh metas, dictation ghost metas, change-tracking reloads.
  - **Included:** adoption transactions. **⌘Z undoes an agent's write in the open editor**, and the undo then autosaves. This is deliberate and covered by `external-revert-adoption.test.tsx`.
  - Summoning, reverting and dismissing a widget are ordinary history steps.
  - History is per editor instance and survives tab switches, because the instance outlives the mount.
- **Palette undo:** the tab controller's `history.undo/redo` calls `editor.commands.undo/redo` (`editor-store.ts`).
- **Document history (checkpoints)** belongs to the git spike; the editor only sees its effects as adoptions.
  - A separate git repo at `<ws>/.notefig/.git` (`desktop/src/modules/history/history.ts`) takes a checkpoint after every completed agent turn.
  - Agent tools `history_checkpoint/diff/log/restore` live in `desktop/src/modules/agents/tools/`.
  - Restore writes through `documents.write`, so it adopts into open editors like any agent write.

### 2.8 Agent-facing coordinate contract (important for the port)

- **Widget-context resource** (`desktop/src/modules/agents/widget-context-resource.ts`): returns `{documentTitle, documentPath, outline[{level,text}], position{headingText}, surroundingText, selectedText, selectedRange{from,to}, otherOpenFiles}`. It reads the **live editor doc** when one is open, and otherwise parses from disk with the fallback codec. `pos`, `from` and `to` are **ProseMirror positions** captured at send time and never re-mapped.
- **`document_read_range({path, from, to})`** (`desktop/src/modules/agents/tools/document-read-range.ts`) returns a slice in the same PM coordinate space.
- **`desktop/src/components/editor/document-outline.ts`**: `extractOutline`, `nearestPrecedingHeading` and `windowAroundPos` are pure helpers over the PM doc.
- **Port rule (Option A):** keep PM's position arithmetic exactly:
  - each boundary of a non-leaf node counts 1;
  - text counts in **UTF-16 code units**;
  - each leaf node counts 1;
  - `textBetween(from, to, blockSep, leafText)` semantics are identical.

  A fork whose positions are block-ID based (§5.1a) must provide an exact PM-position ↔ (blockId, offset) mapping, or the tool contract must be versioned together with `mcp-instructions.ts`.

### 2.9 Find in file and go-to

- `TabController.search` calls `fs.searchContent(dir, {query, fileIncludes:[path]})`, which searches the bytes on disk.
- `resolveSearchTarget(doc, {matchText, lineText, occurrence})` (`desktop/src/components/editor/editor-position.ts`) re-finds each match in the *rendered* text. It never maps raw line and column:
  1. Find all occurrences of the match text.
  2. Keep the one whose rendered line best matches `lineText`.
  3. Break ties with the occurrence index.
- **Block targets** (`{blockId}`):
  1. Wait up to 2 s for the widget's element (via MutationObserver).
  2. Flash a ring around it for 1.5 s.
  3. Call `revealWidget`.

---

## 3. Embedded interactive widgets

### 3.1 Widget protocol (`widgets/src/define-widget.ts`)

`EditorWidgetDefinition` has these fields:

- `name`
- `base`: the worker-safe schema plus the markdown spec
- `view`: `base.extend` with the node view and plugins
- `support{bases, views}`: extra schema nodes
- `codec{serialize, parse, strip}`: pure string functions
- `minimap(services) → MinimapSource`
- `reveal(view, pos)`
- `inlineHostable`

The three rules of the protocol:

1. Two halves sharing one `base`.
2. A pure codec.
3. Nothing impure is imported. Everything from the app arrives through `PromptWidgetHost` (React context) or the `prompts: PromptWidgetsApi` option.

`UI_ONLY_TRANSACTION_META = "uiOnlyNodeChange"`.

UI surfaces:

- **React node views:**
  - `aiPrompt` (PromptBlob)
  - `promptDraft` (a small view that sets `data-draft-empty`, 1e5834db)
  - `image` (EditorImage)
  - `frontmatter` (hidden)
- **Plugin-view and decoration UIs** (vanilla DOM or `createRoot`):
  - the language picker
  - the diff card (custom element `<notefig-diff-block>` with a shadow DOM)
  - the minimap rail
  - the change gutter
  - the dictation ghost

### 3.2 The AI prompt widget

#### 3.2.1 Data

- **Node attrs:**
  - `summoned`
  - `blobId`
  - `taskId`
  - `reference: {text, from, to} | null`: the selection captured at summon time, at most 8000 chars, never serialized
- **Draft:** the `promptDraft` child (text, mention chips, hard breaks).
- **Service state:** `widgets/src/prompt/widgets-service.ts` (`createPromptWidgets`), registered as `core.promptWidgets` in `desktop/src/modules/prompt-widgets/prompt-widgets.ts`.
  - Each `blobId` has a `PromptWidget`. Its fields:
    - `state`
    - `boundTaskId`, `boundTurnId`
    - `lastSentPrompt`
    - `documentPath`
    - `removalRefusedAt`
    - `outcome` (`RoundOutcome`: response, summary, error, touched files)
    - `seenTurnId`
  - `PromptWidgetsApi`:
    - `get`, `subscribe`
    - `round(blobId)`: the live snapshot
    - `review`: the change store
    - `setDocument`
    - `restore(blobId, taskId)`: from the file marker; never clobbers a live binding
    - `rebind`, `unbind`
    - `refuseRemoval`, `markSeen`
    - `askTrust`, `answerTrust`
    - `send(blobId, prompt, dispatch)`, `stop`
    - `findByTask(taskId, turnId)`, …
  - Dependencies:
    - `observeRound`: subscriptions on `agentStore.turns`, `tasks` and `permissionRequests` for the task
    - `observeStoredRound`: `core.promptRounds`, which persists the newest round per widget (MET-251)
    - `announceRound`: emits `"widget:round-started"`
    - `reviewRanges`: a persisted store
- **Persistence:**
  - The file holds only the marker (ids).
  - The app DB holds prompt rounds (status, typed prompt, outcome) and per-document review ranges with a fingerprint.
  - The draft and the reference are **not** persisted; a reload drops them.

#### 3.2.2 Lifecycle in the document (`widgets/src/prompt/node-view.tsx`, `doc-helpers.ts`)

- **Keeper.** A doc with no real content always has exactly one widget. (`docHasRealContent` ignores contentless nodes such as frontmatter and widgets.)
  - The widget sits at the top, after frontmatter, with an empty paragraph below it as a caret landing spot.
  - The insert is `addToHistory:false` and UI-only.
  - If the widget is deleted while the doc is still empty, it comes back.
- **`/` summon** (`handleTextInput`):
  - In a draft, `/` is plain text.
  - With a non-empty selection, `selectionSummonTr` inserts a summoned widget carrying `reference` *after* the block where the selection ends: in the innermost list item that admits it, otherwise after the top-level block. The selection stays and the `/` is consumed.
  - In an empty doc, `/` moves the caret into the keeper.
  - In an empty paragraph at top level, or nested only in bullet/ordered/task lists, `slashSummonTr` replaces the paragraph with a summoned widget.
  - In blockquotes, code and tables, `/` types normally.
  - All summons are normal history steps, and the caret goes to the end of the draft.
- **Revert and dismiss:**
  - Esc or a second `/` in an empty *summoned* draft turns the widget into a paragraph containing `/` (`revertToSlashTr`).
  - Backspace in an empty draft leaves an empty paragraph (`removeToParagraphTr`).
  - A selection-summoned widget is deleted, and the caret goes to the end of the block above (`deleteWidgetTr`).
- **appendTransaction**, in order:
  1. A gap cursor beside a widget is carried to text.
  2. Kept widgets are restored (removal guard, §3.2.5).
  3. The keeper runs.
  4. A trailing paragraph is added when the last block is a widget (UI-only).
- **Binding** (`usePromptBinding`):
  - A widget parsed with a `taskId` is restored only if `host.isTaskReachable`.
  - If the task is unreachable, the widget is left unbound and the file is **never edited**: a wiped DB must not strip widgets.
  - The marker follows the service's binding: send sets `taskId`; Edit or dismiss clears it.

#### 3.2.3 State machine (`widgets/src/prompt/machine.ts`, pure)

**States:**

- `composing{confirmingTrust}`
- `sending`
- `working{turn: queued|running}`
- `asking{ask: permission|auth|question}`
- `settled{outcome: done|error|cancelled}`

**Round facts → state** (`stateFromRound`), checked in order:

| Facts | State |
|---|---|
| no turn row | `composing` |
| `authRequired` and the turn is not `completed` | `asking/auth` |
| turn `queued` | `working/queued` |
| turn `running` with a pending permission | `asking/permission` |
| turn `running` | `working/running` |
| turn `error` | `settled/error` |
| turn `completed` with `awaitingReply` (a widget_respond choice kind) | `asking/question` |
| turn `completed` | `settled/done` |
| turn `cancelled` | `settled/cancelled` |

**Events:**

| Event | Effect |
|---|---|
| `trustAsked` / `trustAnswered` | toggle `confirmingTrust` while composing |
| `sendStarted` | → `sending`, if the field is editable |
| `sendFailed` | `sending` → `composing` |
| `dispatched{facts}` | `sending` → the state from `stateFromRound` |
| `roundChanged{facts}` | applied, except while `sending` (ignored then) |
| `unbound` | → `composing` |

**Capabilities.** All behaviour reads these (`capabilitiesOf(state, {summoned})`), never the state itself:

| state | fieldEditable | removable | escape | liveDraft |
|---|---|---|---|---|
| composing | ✓ | ✓ | revert if summoned, else leave | – |
| sending | – | – | leave | ✓ |
| working | – | – | stop | – |
| asking/auth | – | ✓ | leave | – |
| asking/permission | – | – | stop | – |
| asking/question | ✓ | ✓ | leave | ✓ |
| settled | ✓ | ✓ | leave | – |

`phaseOf(state)` maps the state to the face's `BlobPhase`: composing, sending, queued, running, needs-permission, needs-auth, needs-answer, error or done.

#### 3.2.4 Faces (`widgets/src/prompt/ui/prompt-blob.tsx`, 2,346 LOC; `widget-response-view.tsx`)

The widget is a rounded, bordered card.

- Done is a quiet resting face: no shadow, softened.
- Active phases look raised.
- Attention states get an amber or muted wash.
- A done round whose response is an `issue` gets an amber-tinted border.

The parts of the card:

- **DraftRow:** the single content hole (a `contentDOM` that never moves).
  - **While composing** it shows a **SessionControl**: the harness logo plus a session picker. The picker lists live sessions (`useSessionList`) and "new conversation on <harness>" entries (`useHarnessList`). Choosing one calls `adoptSession`, `dropSession` or `rebind`.
  - **Also while composing** it shows the trust warning ("Send again to let <harness> act here").
  - **While replying** it shows a divider.
  - The row is hidden when the field is not editable.
  - The placeholder depends on the phase and mentions the dictation key.
  - A **ReferenceChip** sits above it: the quoted selection, muted, removable only while composing.
- **Sending / running (StatusRow):**
  - the sent prompt;
  - a shimmering tool-activity line while a tool call is in flight (`deriveActiveToolLine`: tool title plus file basename, debounced), or a teaser of the latest assistant text;
  - the queue position (`deriveQueuePosition`);
  - Edit, Stop and Open-chat buttons, in reserved slots so the width doesn't jump;
  - an `OrbLoader`.
- **Asking:**
  - permission: `slots.PermissionCard({taskId})`;
  - auth: `slots.AuthCard({task})`;
  - question: the question markdown plus **ChoiceOptions** chips.
    - A single-choice chip answers on click. Multiple-choice chips have checkboxes plus a send arrow.
    - ↑ from the field moves the keys onto the options. ←/→/↑/↓ move between options, digits 1–9 pick, Space toggles, Enter sends.
    - Typing returns to the text answer.
- **Done (DoneState):**
  - `WidgetResponseView`: a heading with the harness logo tinted by kind, the title, and the markdown via `slots.Markdown`;
  - if there is no response, the last assistant line as a fallback summary;
  - **TouchedFileChips**: the files the round changed, each with its change count and a ChangeDot. Clicking the chip for the widget's own document toggles **review** (gutter bars); clicking any other chip opens that file;
  - a reply field, Open chat, and Dismiss (✕).
- **Error (ErrorState):**
  - the error message;
  - Retry (same prompt);
  - Edit (unbind and put the typed prompt back);
  - Dismiss;
  - a reply on the same session.
- **RemovalRefusedHint:** when the user tries to delete a widget that isn't removable, the card shakes and says "stop it first".
- **AnimatedHeight** transitions between faces.

**Render optimizations:**

- The face re-renders only on attr changes, draft emptiness, or `liveDraft` (f537f242).
- The draft-empty placeholder is driven by the draft node view's `data-draft-empty` plus a CSS `:has()` rule (1e5834db).
- Re-renders when the selection toggles are skipped (db39fc0c).

#### 3.2.5 Keyboard and document interaction rules (`node-view.tsx:addKeyboardShortcuts`, `interactions.ts`)

Every handler first calls `syncSelectionFromDOM`, which catches PM up with the browser caret (otherwise the caret is stale after Home, End and arrows under load). Keys pressed inside a draft go to the composer handler (`key-bridge.ts`, `deriveComposerKeyAction`).

| Key | Behaviour |
|---|---|
| **Enter** | Send: a fresh send while composing, a follow-up on the same session when settled or asking. On a NodeSelected widget, enters the draft. |
| **Shift-Enter / Mod-Enter** | Hard break in the draft. HardBreak's own command bails in isolating nodes. |
| **Escape** | Cancel while in flight (cancel-and-forget puts the prompt back if the agent had not answered). Revert when the draft is empty and the widget was summoned. Otherwise hand focus back to the document. |
| **`/`** | Revert when the draft is empty and the widget was summoned. |
| **Backspace** | First applicable, in order: (1) delete a range over widgets; (2) composer dismiss (empty draft); (3) delete a selected widget, refused if not removable; (4) at line start below a widget, *select* the widget instead of merging; (5) inside a draft, a character delete clamped to the draft. Always consumed, because WebKit's native cross-boundary delete mangles the DOM. A mention chip uses the Mention extension's own Backspace, which turns it back into text. |
| **Delete** | Mirror of Backspace. |
| **Mod-Backspace / Alt-Backspace / Ctrl-k** | Clamped to the draft; always consumed. |
| **Mod-a** | Selects the draft first; a second press selects the document. |
| **ArrowUp / ArrowDown** | An open mention popup owns them. Choice options come next. Otherwise `arrowAcrossWidget`: one press enters or leaves the draft (Chromium otherwise sticks). `arrowOntoReadOnlyWidget` NodeSelects a widget whose field isn't editable. |
| **Digits, Space** | Forwarded (choice picks). |

**Rules** (`interactions.ts`, MET-248):

1. **Field:** the draft takes typing only when `fieldEditable`. The caret is never left in a read-only draft.
2. **Removal:** any edit is allowed to apply (range delete, Cmd-A plus typing, cut, undo, drag). A non-removable widget is then *put back* (`restoreKeptWidgetsTr`, `refuseRemoval`). Text typed over widgets goes into the document, never into the next widget's draft.
3. **Selection:** only the keyboard NodeSelects a widget; a click never does. Selected and in-range widgets get the selection tint (`data-widget-selected`, a decoration computed by walking *only the selection*, 3b8db41e).
4. **Escape** follows `capabilities.escape`.

**Paste and drag:**

- A pasted or drag-copied widget is always fresh: `renderHTML` carries no ids, so the node view mints a new `blobId` on mount.
- A drag *move* keeps the widget's identity.
- A paste into a draft replaces the selection with plain text, but only when the selection is fully inside the draft (22042c03).

#### 3.2.6 Talking to the agents layer: `PromptWidgetHost` (`widgets/src/prompt/host.ts`)

This is the seam with the agents spike.

**Host methods:**

- **Sessions:**
  - `startOrGetSharedSession(ws) → taskId`: the workspace's shared session; resolves only when the session is ready.
  - `adoptSession(ws, taskId)`, `dropSession(ws, harnessId)`, `peekSession(ws)`.
  - `isTaskReachable(taskId)`.
- **Send and stop:**
  - `dispatchPrompt({taskId, text, workspacePath, target: {path, pos, isDocEmpty, reference?}}) → {turnId, sentPrompt}`. It is infallible.
  - `cancelTask`, `removeQueuedPrompt`, `ensureRuntime`.
- **Live hooks:**
  - `useRound({turnId, taskId}) → {turn, task, entries, taskTurns, pendingPermissions}`.
  - `useSessionList`, `useDefaultHarness`, `useHarnessList`.
  - `useTrust(ws) → {isTrusted, grant}`.
- **Files and directives:** `isWorkspaceFile`, `searchWorkspaceFiles`, `toRelativePath`, `directives({workspacePath, taskId})`.
- **Chrome:** `openFile`, `openAgentTab`, `focusDocument(path, {reason, steal})`.
- **Slots:** `Markdown`, `PermissionCard`, `AuthCard`, `FileIcon`, `DirectiveIcon`, `HarnessLogo`.
- **Optional:** `dictation`, `useDictationKey`.

**Send flow:**

1. The trust gate runs. The first send in a workspace asks twice.
2. `ensureRuntime`.
3. `prompts.send(blobId, typed, dispatch)` moves the widget to `sending`.
4. The host resolves the session and the directives (`core.directives.resolve(text, ctx) → {text, extras{commands, config}}`). File mentions become context parts.
5. `core.agents.task(id).promptFromWidget(text, {workspacePath, path, pos, isDocEmpty, reference}, extras)`. The agent receives:
   - the text;
   - the reference, quoted as a blockquote;
   - a `resource_link` to the widget-context URI.

   If the doc is empty, the prompt says so inline.
6. `dispatched{facts}` fires, the round is announced (`announceRound`), and the marker's `taskId` is written.
7. The agent answers by calling the **`widget_respond`** MCP tool (`desktop/src/modules/agents/tools/widget-respond.ts`; schema in `shared/src/agent/widget-response.ts`).
   - Input: `{kind: answer|issue|single_choice|multiple_choice, markdown, title?, options?}`.
   - Limits: title 80 chars, question 200, option 60.
   - Diff fences are refused; the agent is told to put them in the document instead.
   - The response is *derived from the transcript* (`deriveWidgetResponse`, last call wins) and is not stored separately.
8. When the round settles, its outcome is snapshotted into the prompt rounds store.

#### 3.2.7 Change tracking and review (`change-tracking.ts`, `change-store.ts`, `change-gutter.ts`, `change-navigator.ts`)

- **Recording.** A transaction tagged with `PROMPT_CHANGE_META {blobId, turnId}` records every span its steps touched (`touchedSpans`; a mark step contributes its own range). Spans are narrowed to text per block, and widgets never count.
- **Mapping.** Every other transaction only maps the recorded spans. A span that collapses is dropped, unless it records a pure deletion (`from === to`).
- **Persistence.** The plugin state is mirrored to `prompts.review` and persisted with a document **fingerprint**. Saved ranges load as `unchecked` and are adopted only if the fingerprint matches. They are discarded when the widget binds a new turn.
- **Gutter.** A layer beside the editor, not decorations: one bar per changed block, in the widget's colour.
  - Only the widget under review is drawn.
  - `revealPromptChange` scrolls to a change and pulses its bar.
  - The navigator counts and steps through changes; its stepping UI isn't rendered yet.

#### 3.2.8 Minimap (`widgets/src/minimap/*`, `prompt/minimap.ts`)

- A rail pinned top-right inside the scroller (a sticky host of zero height), with one dot per widget.
- **Dot state:** a core of neutral, attention, error or fresh, plus hollow/breathe/pulse/ping modifiers, all derived from the widget state. `fresh` means a result the user hasn't seen yet.
- Each dot has a tooltip with the widget's title. Clicking it scrolls to the widget and calls `revealWidget`, which focuses the draft.
- The rail uses an SVG goo filter. It is a WebKit perf hotspot; drop or replace it in the port.

### 3.3 Image node view (`desktop/src/components/editor/editor-image-node.tsx`, `editor-image-paste.ts`)

- **Resolving the source.** A relative `src` resolves against the doc's directory first, then the workspace root (Obsidian-compatible), via `fs.resolveAssetUrl` / `useImageUrl`.
- **Focus.** The image is a focusable, non-editable island that hands focus to the editor.
- **Drag payload.** The node declares a drag-protocol payload (the doc path), so moving the asset elsewhere can rewrite the doc.
- **Paste or drop from the OS** (files or clipboard images):
  1. The file is written to `<docDir>/assets/<name>`.
  2. The name is normalized (spaces become `-`, parentheses are removed) and de-duplicated with a `-1`, `-2`, … suffix.
  3. `image{src:"assets/<name>"}` is inserted.
- **Drop from the file tree** (`text-editor.tsx` dropZone): an image inserts a workspace-relative `src`; any other file opens in a tab.

### 3.4 Frontmatter (`frontmatter-node.tsx`, `frontmatter-popover.tsx`, `frontmatter-value-types.tsx`)

- The node renders **nothing** in the page.
- A tag button in the toolbar opens the **Properties popover**: key/value rows edited through the `yaml` library's `Document` API, which preserves comments, key order and unknown keys byte for byte.
- A value-type registry supplies each value's icon and editor: tags as chips, booleans, numbers, dates, and generic text as the fallback.
- `setFrontmatterYaml` creates the node lazily on the first commit. The commit is a normal history transaction and autosaves.

### 3.5 Diff blocks in the editor (`widgets/src/diff-block/{extension,element,card,patch}.ts*`; `desktop/src/modules/diff-blocks`)

- **Card.** A code block with `diff:true` and parseable hunks (`@pierre/diffs` `processFile`) is drawn as a **card**:
  - **Header:** the file label (a link if it is a workspace file, via `DiffBlockHost.resolveFile`), the file-type icon, `+N −M`, and an Edit button.
  - **Body:** the diff, drawn by Pierre with Shiki highlighting. Side by side when both sides exist and lines fit in 80 columns; unified otherwise. Lines wrap.
  - The source is hidden.
- **Where cards appear.** The card element is registered app-wide by `diffBlocksModule`, so chat and widget responses use it too. Cards for agent edits start collapsed, and Pierre is mounted only when a card is open.
- **Selection** works like the widget's:
  - An arrow key, or Backspace/Delete from the neighbouring line, NodeSelects the block.
  - A click or drag inside the card belongs to the code.
  - No selection end may rest inside the hidden source; the selection expands to include the whole block.
  - While the block is selected, digits run its numbered controls.
- **Edit mode.** Enter on a selected block, or the Edit button, shows the raw highlighted source plus the language picker until the selection leaves. Escape selects the block again. Edit mode is presentation only.
- `patchOf(path, before, after, line)` builds diff blocks for agent edits.

### 3.6 Code blocks: highlighting and language picker

**`codeHighlight`** (`widgets/src/code-highlight.ts`):

- Uses Pierre's shared **Shiki** highlighter with the themes `pierre-light` and `pierre-dark`.
- Each token carries both colours (`color` plus `--shiki-dark`), so switching theme costs nothing.
- Colours are inline decorations, mapped through edits.
- A block is re-tokenized only when a transaction touches a code block (`touchesCode`), or when a language finishes loading (a meta transaction, not added to history).
- Blocks over 20 000 chars stay plain.
- Languages load lazily; an unknown language stays plain.
- Recent fixes: 6eccdb68, fb20149b.

**`codeLanguagePicker`** (`code-language.tsx`):

- A widget decoration in the block's corner that opens a React popover command list.
- Languages offered: bash, c, cpp, csharp, css, diff, go, html, java, javascript, json, jsx, kotlin, markdown, php, python, ruby, rust, sql, swift, toml, tsx, typescript, yaml, plus plain text.
- A language not on the list (an alias such as `ts`) is shown as written.

### 3.7 Mentions, page links, directives

- **In drafts:**
  - The `@` Suggestion is scoped to drafts by `allow`. It searches workspace files and directive candidates (`core.directives.sources`).
  - The popup, `PromptMentionMenu`, is mounted beside the editor and keyed by document. While it has rows it owns ↑, ↓, Enter and Escape (`mention-bridge.ts`).
  - Picking inserts a `mention` chip (`@path`) or a directive token.
- **Directive namespaces.** Each one registers `candidates(ctx)` and `resolve(values, ctx) → {commands, config}` (`desktop/src/modules/directives/directives.ts`). Their tokens are stripped from the text before sending.
- **Page links in prose:** `PageLinkSuggestion` (§1.5).
- **WebKit caret repaint fix:** `suggestionCaretRepaint` (`mention-suggestion.ts`).

### 3.8 Dictation (`widgets/src/dictation/extension.ts`; service in `@notefig/dictation`)

- The editor registers as a target via `host.attach`.
- While dictating, the partial words show as a muted inline **decoration ghost** at the caret. They are never in the doc. A leading space is inferred from the text before the caret.
- The final text is inserted in one transaction, so one undo removes it.
- A voice-wave widget appears in the prompt face.
- The model is Parakeet (bundled).

The engine and service are out of scope. The editor contract is: a target that shows a ghost range and accepts a final insert.

---

## 4. Editing UX ("the tiptap experience")

### 4.1 Chrome around the document (`desktop/src/components/editor/text-editor.tsx`)

- **Fixed toolbar** (`tiptap-toolbar.tsx`, `tiptap-toolbar-buttons.tsx`):
  - H1, H2, H3
  - Bold, Italic, Underline, Strike
  - Bullet list, Numbered list
  - Blockquote, Code block
  - Insert table (3×3 with a header row)
  - Link
  - Properties (frontmatter), pinned at the right end

  Active states come from `isActiveIn`, which answers every question from one walk of the selection (0eba59cf). Subscript, superscript and highlight have no button; they are reachable only by shortcut.
- **Document column:** `prose prose-sm max-w-2xl mx-auto p-4` (Tailwind typography), `0.75em` between blocks, a full-contrast foreground caret. The scroller fills the pane.
- **Clicks outside the text:** a click in the gutter or padding focuses the editor at the nearest position (clamped) without scrolling. A click below the content puts the caret at the end.

### 4.2 No slash menu, no floating menu

`/` is the AI summon (§3.2.2). There is no block-type picker; block types come from the toolbar, markdown input rules and shortcuts.

There are two bubble menus (Tiptap `BubbleMenu` on Floating UI):

- the **link** menu, shown when the selection is in a link (its `shouldShow` is stable at module scope, 011600ed);
- the **table** menu, shown inside a table but not inside a link.

### 4.3 Drag handle

- `@tiptap/extension-drag-handle-react` with a `GripVertical` icon.
- `nested` mode: list items get their own handles.
- A rule excludes `promptDraft` from being a drag target.
- Dragging moves the block (NodeSelection plus PM drag-and-drop, with Dropcursor).
- Drop handlers are composed: `createProtocolDropHandler` (the app's drag protocol: tree files, tabs), then `createImageDropHandler` (OS image files).

### 4.4 Selection behaviour

- Native contenteditable selection: double-click selects a word, triple-click a paragraph. Shift+arrows extend, Alt word-jumps, Cmd line-jumps.
- A gap cursor between non-text blocks, except next to widgets.
- NodeSelection on images, HRs and diff blocks. Widgets are NodeSelected by keyboard only.
- **Mousedown fix** (`editor-store.ts`): when the view has lost DOM focus (layout re-parenting), the selection is set to `posAtCoords` *before* the browser focuses it, so PM's focus restore lands at the click.
- Selection and viewport are remembered per instance (§4.11).
- `selectedText()` seeds Mod+F and the prompt reference.

### 4.5 Tables

Built on prosemirror-tables via Tiptap.

- **CellSelection:** dragging across cells selects them, with a `.selectedCell` tint.
- **Column resize handles** (`resizable:true`). Widths live in `colwidth` attrs and are **not saved to markdown**.
- **Keys:**
  - Tab and Shift-Tab move between cells; Tab in the last cell adds a row.
  - Enter in a cell creates a new paragraph. The table is then no longer GFM-shaped and is **saved as HTML**.
- **Menu** (`tiptap-table-menu.tsx`): add row after, add column after, delete row, delete column, delete table.
- **Look:** bordered cells, a bold header row on a tinted background, and horizontal scroll via `.tableWrapper`.

### 4.6 Links

- **Add or edit:** from the toolbar or the bubble's Edit, a `platform.ui.promptText` modal opens (`use-link-prompt.ts`).
  - An empty URL removes the link.
  - `normalizeLinkInput` keeps URLs with a scheme, paths, anchors and text-file names as they are, and prefixes `https://` to bare domains.
- **Bubble menu: Open / Edit / Unlink.**
  - External links (http, https, mailto) open in the OS browser.
  - An internal href resolves against candidates: relative to the file first, then to the workspace, clamped to the workspace. It opens in a new tab; a toast reports a missing target.
- Clicking a rendered `<a>` never navigates.
- No autolink, no linkify.

### 4.7 Task lists

- The checkbox is clickable and toggles `checked` (a normal transaction, autosaved).
- Input rule: `[ ] ` or `[x] ` typed at the start of a bullet item.
- `Mod-Shift-9` toggles a task list.
- No nesting (`nested:false`).

### 4.8 Code blocks

- Input rules ```` ``` ```` and `~~~`, each with an optional language.
- `Mod-Alt-c` toggles a code block.
- No marks inside code.
- Highlighting and the language picker: §3.6.
- Copy and paste inside a code block are plain text. (`transformPastedText` parses inline markdown only outside code.)

### 4.9 IME, RTL and input plumbing

- **IME** is entirely the browser's: composition events in the contenteditable, plus PM's DOMObserver.
- **WebKit workarounds in place:**
  - a caret repaint after suggestion decorations;
  - a full-contrast `caret-color`;
  - `letter-spacing: normal`, because WebKit draws the caret inside trailing letter-space;
  - the native `format*` and `history*` beforeinput intercepts (§1.5).
- **RTL** is per block (§1.5). WebKit needs an explicit `text-align: start`, and an inline-block wrapper so widget-only list items still get markers.
- **Free from WKWebView:** spellcheck, autocorrect, macOS text replacement, Look Up and Writing Tools. A native port loses them unless it rebuilds them (§5.4).

### 4.10 Focus

- The focus arbiter is `requestTabFocus` plus the tab controllers.
- Ambient intents never steal focus from a sidebar rename field or the chat composer. Ambient means tab select, mount, or a layout reclaim within 600 ms.
- Explicit hand-offs pass `steal`.
- `focus()` never scrolls (`scrollIntoView:false`); only `goTo` scrolls.

### 4.11 Viewport save and restore (`use-editor-viewport-memory.ts`)

- The saved value is a **document position** at the top of the visible area (`posAtCoords` taken down the middle of the column), not a pixel offset. It therefore survives adoptions that move offsets.
- When it is saved:
  - on main, every animation frame;
  - on perf-combined, 150 ms after scrolling settles (12971625), plus on unmount if a save is pending;
  - skipped when the editor has no view (cf196497).
- **Restore:** `domAtPos(pos)`, then `scrollIntoView({block:"start", inline:"nearest"})`. It is accurate to the start of the block.
- The selection is restored on mount (`use-editor-focus-lifecycle.ts`) before `markMounted`, so a pending `goTo` wins.

### 4.12 Performance work and SLOs (what the port must beat)

`desktop/tests/perf/slos.json` defines the SLOs enforced on PRs:

- caret move, select-all, caret-out-of-select-all, and type-and-delete, all on an **8,000-line doc**;
- prompt-widget typing and caret moves;
- tab switch (README ↔ the 8k doc);
- file open, new scratchpad, palette, settings, search, chat open;
- workspace open (20k files);
- memory.

Lessons from the perf work. Each is a constraint on the port's architecture:

- **The whole 8k-line doc is live DOM** (~26k elements, 41k layout objects). Each keystroke pays ~20 ms of browser layout, and class toggles restyle everything (3993eb76: 128 ms → 0.2 ms). The port **must virtualize** block layout and painting.
- **Per-keystroke work over the whole document is fatal.** Examples that were fixed:
  - per-block decorations: 25 ms per keystroke (532b4b55);
  - a document walk for widget selection: 2.3 ms (3b8db41e);
  - 17 toolbar `isActive` calls over a range (0eba59cf);
  - viewport hit-testing on every scroll frame: 4.3 ms (12971625).
- **Empty transactions are not free.** Each Backspace dispatched 4 no-op transactions, each a full view update; they are now filtered out (052d4f96).
- **Node views must not re-render on selection changes:** 30 → 0 React commits on select-all (db39fc0c).

Current numbers (p50/p95, on a loaded machine):

- typing in the 8k doc: p95 93 → 50 ms;
- typing in a widget: p50 30, p95 52 ms;
- select-all: p50 66–74 ms.

**Target for the GPUI port: under 8 ms per keystroke on the 8k doc** (one 120 Hz frame).

---

## 5. Rust / GPUI port (Option A)

### 5.0 Decision: Option A

The user chose **A**: a schema-checked node tree with PM-compatible positions, steps and mapping, behind a custom GPUI view. Markdown syntax is never visible, as today.

What this commits us to:

1. **Byte-exact serializer parity** (§1.7). The lossy cases stay as they are.
2. **Adoption by structural diff** (§2.4).
3. **PM position arithmetic** for the agent tools (§2.8).

The rejected alternative was **B**: the markdown text itself as the model, with CodeMirror 6 / Obsidian-style live preview. It was estimated at about 28–34 pw to MVP and 48–58 to parity. It would show syntax near the caret. It remains a fallback if Option A's view work overruns.

### 5.1a Base: fork `wabzqem/gpui-kit-markdown-editor`

The platform spike recommends forking **`wabzqem/gpui-kit-markdown-editor`** as the base for Option A. It is ProseMirror-shaped and already has:

- block IDs
- invertible steps
- transactions
- undo
- input rules
- tables
- IME
- a markdown-rs parser

This spike has not reviewed its code. Before the fork is committed, audit it against §5.1:

- **Position model.** Block IDs vs PM integer positions: is an exact mapping possible (§2.8)? Are text offsets in UTF-16?
- **Steps and mapping.** Does mapping compose across transactions, as change tracking, decorations and history rebasing need?
- **Plugin hooks.** Are `filterTransaction`, `appendTransaction`, decorations and plugin views supported?
- **Node views.** Do they support an editable content slot, as the prompt draft needs?
- **Markdown.** Can the serializer be made byte-compatible with prosemirror-markdown (the golden corpus in §5.5)? Can the markdown-rs parse reproduce the markdown-it semantics in §1.7?
- **Tables.** CellSelection, column resize, and the GFM-shaped vs HTML serialization rule.
- **Virtualization and performance** on the 8k-line fixture.

The estimates in §5.6 assume a from-scratch build. If the audit passes, expect the model, state, history, input-rule, table and IME rows to shrink substantially; re-estimate after the audit.

### 5.1 What a ProseMirror-compatible model in Rust needs

Port the semantics of `prosemirror-model` and `-transform`, plus parts of `-state`, `-commands`, `-history`, `-inputrules`, `-keymap` and `-tables` (about 10–12 kLOC of TS). Do not port the view. Keep the API shapes, so the TS logic (widgets, adoption, change tracking) ports almost line for line.

**model**

- **`Schema`.** NodeSpecs and MarkSpecs with:
  - `content` expressions compiled to a `ContentMatch` DFA (same grammar: `|`, `*`, `+`, `?`, `{n,m}`, groups);
  - `group`, `marks`, `atom`, `isolating`, `selectable`, `draggable`, `allowGapCursor`, `code`, `defining`, `inline`;
  - attrs with defaults, and `topNode`;
  - for marks: `inclusive`, `excludes`, `spanning`.
- **`Node`.** Persistent and `Arc`-shared: type, attrs, `Fragment`, marks, text. Sizes are in PM units: text counts **UTF-16 length** (keep a cached `utf16_len`), a leaf counts 1, a non-leaf counts content + 2.
- **`Fragment`:** `cut`, `replaceChild`, `append`, `findDiffStart/End`.
- **`Mark` / `MarkSet`:** sorted by rank.
- **`ResolvedPos`:** depth, parent, index, start, end, before, after, `marks()`, `sharedDepth`, `blockRange`. Cache it per doc.
- **`Slice{content, openStart, openEnd}`** and the **replace algorithm**, including `checkContent`.
- **Utilities:** `Node::check()`, serde `toJSON`/`fromJSON` (matching today's JSON shape), `textBetween`, `nodesBetween`, `descendants`.

**transform**

- **Steps:** Replace, ReplaceAround, Add/RemoveMark, Add/RemoveNodeMark, Attr, DocAttr. Each step supports `apply`, `invert`, `getMap`, `map` and `merge`.
- **`StepMap` / `Mapping`:** `mapResult` with deleted flags, `slice`, `appendMap`, and mirroring.
- **Transform helpers** used by the TS code:
  - `replaceWith`, `insert`, `delete`
  - `setNodeMarkup`, `setNodeAttribute`
  - `split`, `join`, `lift`, `wrap`, `setBlockType`
  - `addMark` / `removeMark`, `clearIncompatible`
  - `replaceRange`: the Fitter, the hardest single piece
  - `deleteRange`, `liftTarget`, `findWrapping`, `canSplit`, `canJoin`

**state**

- **`EditorState`** with doc, selection, storedMarks and plugin states.
- **`Transaction`** with meta, time, scrolledIntoView, and selection and stored-marks flags.
- **Selections:** Text, Node, All, GapCursor and Cell, plus `near` / `findFrom`. All of them are mapped through transactions.
- **Plugins:**
  - `state{init, apply}`;
  - `filterTransaction` (the empty-tr filter);
  - `appendTransaction` (the keeper, restore-kept, trailing paragraph);
  - props: `handleKeyDown`, `handleTextInput`, `handlePaste`, `handleDrop`, `decorations`, `nodeViews`;
  - `view` (the minimap and the gutter).

**commands, history, inputrules, keymap**

- **Commands** (the subset in use):
  - `joinBackward` / `joinForward`, `deleteSelection`, `selectNodeBackward` / `selectNodeForward`
  - `splitBlock`, `liftEmptyBlock`, `createParagraphNear`, `newlineInCode`, `exitCode`
  - `toggleMark`, `setBlockType`, `wrapIn`, `lift`
  - list commands: split, sink, lift, wrap
  - `selectAll`, `chainCommands`
  - Tiptap's `toggleList`, `extendMarkRange`, `insertContentAt`, `isActive`
- **History:** prosemirror-history semantics.
  - Branch-based, with step inversion and remapping over non-history steps.
  - `addToHistory:false` excludes a transaction.
  - New groups start after 500 ms (`newGroupDelay`).
  - `closeHistory`.
  - Adoption steps *are* recorded in history (§2.7).
- **Input rules:** regex rules on the text before the caret (all of §1.3/§1.4). Backspace right after a rule undoes it.
- **Keymap:**
  - `Mod` is Cmd on macOS, Ctrl elsewhere.
  - Keymaps have priorities, and a binding that returns `false` falls through to the next one. The widget keymap relies on this order.

**tables:** TableMap, CellSelection, add/delete row and column, `fixTables`, `goToNextCell`, and column resize state.

**decorations:** a `DecorationSet` (inline, node and widget decorations) whose `map` is incremental. They are used for code highlighting, the language picker, the widget selection tint, the diff card, the dictation ghost, suggestion ranges and the placeholder.

**markdown**

- **Parse.** Build the doc directly from markdown-rs (from the fork) or pulldown-cmark events; *do not go through HTML*. It must still reproduce markdown-it's semantics:
  - raw HTML: `u`, `mark`, `sub`, `sup` become marks; the prompt-marker comment becomes a widget; other HTML is unwrapped or dropped as in §1.7;
  - frontmatter is split off first;
  - the empty `- [ ]` fallback;
  - the diff info string;
  - images split their paragraph;
  - both hard-break forms;
  - entity decoding.
- **Serialize.** Port prosemirror-markdown's `MarkdownSerializerState` (`esc`, `wrapBlock`, `renderList`, `renderInline` with mark nesting and whitespace expulsion, `closeBlock`, `ensureNewLine`), plus the tiptap-markdown overrides and ours (§1.3).

**sync**

- Port `DocumentSync`.
- Re-implement the adoption diff with a structural `Fragment` diff (`findDiffStart/End`) plus `similar` word diffs. This replaces the rfc6902 JSON patch.
- Port widget re-assertion, carrying drafts forward, draft-caret restore, and `isDraftOnlyEdit`.

**View (GPUI)**

- **Layout and virtualization.**
  - One element per top-level block, virtualized with `gpui::list` / `ListState` (variable heights).
  - Each textblock is shaped with `window.text_system().shape_text(text, size, &runs, Some(wrap_width))`, using `TextRun`s built from marks and inline decorations.
  - Block chrome (list markers, checkboxes, quote bars, code background, HR, table grid) is painted around the text.
  - Heading fonts differ, so line heights vary by block.
- **Position ↔ layout maps.** PM positions are UTF-16 while GPUI shaping is UTF-8, so keep a per-block offset table between them. Expose `coordsAtPos` and `posAtCoords` for clicks, viewport memory, popup and bubble anchors, gutter bars and the minimap.
- **Caret and selection painting:**
  - blink;
  - selection rects across blocks;
  - node-selection outline, gap cursor, cell selection;
  - a goal column for vertical moves;
  - word and line boundaries (`unicode-segmentation`);
  - bidi.
- **Input.** Implement `EntityInputHandler`:
  - `text_for_range`, `selected_text_range`, `marked_text_range`, `unmark_text`;
  - `replace_text_in_range`, `replace_and_mark_text_in_range`;
  - `bounds_for_range`, `character_index_for_point`.

  Ranges are UTF-16 over the current textblock or window, mapped to PM positions. Register the handler in paint with `window.handle_input(&focus_handle, ElementInputHandler::new(bounds, entity), cx)`. GPUI actions and keymap contexts route chords into a PM-style keymap that supports fallthrough.
- **Node views.** A `NodeView` trait with `render`, `content_slot` and `stop_event`.
  - Chrome-only views (image, diff card, frontmatter) are plain entities.
  - The prompt draft needs a **`ContentSlot`**: an element the node view places, which the editor fills with its own inline layout and hit-testing for that range. This replaces `contentDOM`.
- **Popups:** gpui-component `Popover` / `deferred(anchored())`, anchored to `coordsAtPos`.
- **Clipboard:**
  - Copy: text/plain, text/html, and a private PM-slice JSON.
  - Paste, in order of preference: our own slice; then HTML (`html5ever` plus Rust ports of the parseHTML rules); then plain text parsed as inline markdown; images go to `assets/`.
- **Drag and drop:** handle drag with a ghost and drop cursor; external `ExternalPaths` drops.

### 5.2 Rust crates that help

| Need | Crate |
|---|---|
| Markdown parse | **markdown-rs** (used by the gpui-kit fork; mdast, frontmatter) / pulldown-cmark (fast, offsets, GFM) / comrak |
| Markdown serialize | our own port of prosemirror-markdown (byte parity) |
| Text storage | ropey / crop (big code blocks) |
| Unicode | `unicode-segmentation`, `unicode-bidi`, `unicode-linebreak` |
| Highlighting | **syntect** + `two-face` (TextMate grammars and VS Code themes, the closest to Shiki and the Pierre themes) or tree-sitter-highlight (incremental) |
| Diff | `similar`, `imara-diff`, `diffy` (unified patch parse and apply) |
| Frontmatter YAML (comment-preserving) | tree-sitter-yaml CST plus span edits, or keep the YAML opaque and edit scalars by span |
| HTML paste | `html5ever` / `scraper` |
| Persistent tree | `Arc<[Node]>`, `im` / `rpds` |
| UI | **gpui-component** (Input/IME, code editor, TextView markdown, Popover, Menu, List, Checkbox, Tooltip) |
| Editor code | **Zed's `editor`/`multi_buffer`/`language`/`markdown` crates.** They are GPL, and the user has confirmed reusing them is acceptable. Mine them for IME handling, display maps, block decorations, soft wrap and selection painting. |
| Hash | `md-5` |

### 5.3 GPUI capabilities checklist (first week)

- [ ] `shape_text` handles mixed fonts, sizes and weights per paragraph, with backgrounds per run.
- [ ] `WrappedLine` hit-testing works at soft-wrap boundaries, with caret affinity.
- [ ] macOS IME: marked text, candidate window positioning, press-and-hold accents. Windows TSF and Linux IBus/Fcitx.
- [ ] `list()` virtualization with variable heights, scroll anchoring and reveal.
- [ ] `img()` with local files loading async; SVG.
- [ ] Multi-format clipboard on each platform.
- [ ] Accessibility status (a contenteditable gets VoiceOver for free today).
- [ ] wasm: keep the model, codec and sync crates free of tokio and filesystem access; the GPUI web backend is experimental.

### 5.4 The hard parts, ranked

1. **Rich-text layout and hit-testing.** This covers variable block styles, nested lists, tables, caret affinity at wraps and around atoms, goal-column motion, and selection painting. *Mitigation:* make the textblock the unit of layout, cache shaped lines per (node identity, width, theme), and never re-shape an unchanged block.
2. **IME and platform text services.**
   - No input rules or `appendTransaction` during composition; commit the composition first.
   - Spellcheck, autocorrect, text replacement, Look Up, Writing Tools and services must each be rebuilt. Spellcheck alone is about 2 pw.
3. **Editable holes in node views** (the `ContentSlot`). The caret must stay in the document so that selection memory, focus and change tracking need no widget special cases.
4. **Tables:** CellSelection, column resize, the Tab state machine, and the GFM-vs-HTML serialization rule.
5. **Bidi:** per-block direction, visual vs logical caret movement, mixed-direction selection rects.
6. **Byte-exact serializer parity:** many small rules; the golden corpus keeps them honest.
7. **The adoption diff:** minimal steps, with a budget and a fallback.
8. **Performance at 8k lines:** virtualization, and decorations computed in O(changed), not O(doc) (§4.12).

### 5.5 Compatibility test strategy

- **Golden corpus.** About 500 real `.md` files plus fuzzed GFM.
  1. A Node script built on the current `createMarkdownCodec()` emits `doc.json` and `out.md` for each file.
  2. The Rust codec must parse to identical JSON (modulo block IDs) and serialize to byte-identical markdown.
  3. Each output must reach a fixed point after at most one normalization.

  Keep the existing round-trip test names as Rust test cases.
- **Position parity.** Compare `textBetween` and `nodeSize` at sampled positions against JS (the agent contract, §2.8).
- **Behaviour suites.** Port the DOM-free logic tests:
  - `adopt-external-content`, `adoption-integrity`
  - `prompt-widget-backspace`
  - `typing-save-integrity`, `editor-save-pipeline`
  - the widget machine and state
  - `draft-only-edit`, `change-tracking`
- **Performance.** Reproduce the 8k-line SLOs as GPUI benchmarks.

### 5.6 MVP subset and estimates (from scratch; re-estimate after the fork audit in §5.1a)

Units are person-weeks for one experienced Rust engineer, tests included. Agent, git and shell work owned by other spikes is excluded.

**MVP:** safe editing of real notes, plus the AI widget's core loop.

| Area | Scope | pw |
|---|---|---|
| Model + transform | schema/ContentMatch, Node/Fragment/Slice/ResolvedPos, replace + Fitter, steps, mapping, JSON | 7–8 |
| State, commands, keymap, input rules, history | | 4–5 |
| Markdown codec | parser → doc, serializer port, frontmatter/markers/diff info/HTML marks, golden corpus | 4 |
| View: layout and paint | virtualized blocks, headings, paragraphs, lists incl. tasks, quote, code, HR, images, hard breaks | 6–7 |
| Caret, selection, hit-testing, scrolling | | 3–4 |
| IME (mac) + clipboard | | 3 |
| Node-view framework incl. ContentSlot | | 2–3 |
| Prompt widget core | keeper, `/` summon/revert/dismiss, removal guard, machine and service, faces: composing, running, done, error; host trait | 5–6 |
| Code highlighting | | 1 |
| Sync | DocumentSync, adoption diff, widget re-assert, draft carry, turn attribution | 3 |
| Chrome | toolbar, link modal and bubble, placeholder, find/goTo, selection and viewport memory, focus | 2 |
| **MVP total** | | **≈ 40–48 pw** (2 engineers ≈ 5–6 months) |

Deferred past MVP:

- Tables: read-only grid (the markdown is kept).
- Diff cards: shown as plain code blocks.
- Choices, and inline permission/auth (they link to the chat instead).
- Change gutter, minimap.
- Mentions, page links, directives, dictation.
- Drag handle.
- Frontmatter popover: replaced by a raw YAML dialog.
- RTL, spellcheck.
- Windows/Linux IME polish.

**Parity delta**

| Area | pw |
|---|---|
| Tables | 5–6 |
| Widget remainder (asking states, session picker, trust, reference/touched-file chips, change tracking, gutter, review persistence, minimap) | 6–7 |
| Diff block card | 3–4 |
| Mentions, page links, directives | 2 |
| Frontmatter popover | 2 |
| Drag handle, block DnD, image paste/drop | 2–3 |
| Bidi/RTL | 3 |
| Spellcheck and text services (mac) | 3–4 |
| Dictation target | 1 |
| Windows/Linux IME and clipboard | 2–3 |
| Perf hardening | 2–3 |
| **Delta** | **≈ 31–38 pw**, for a total of **≈ 70–85 pw** |

Accessibility (screen readers) is budgeted separately at 4–8+ pw, depending on GPUI/AccessKit status.

### 5.8 Interfaces with the other spikes

| Seam | Contract the editor needs | Owner |
|---|---|---|
| `PromptWidgetHost` (§3.2.6) | sessions, dispatch, cancel, round observation, trust, harnesses, file search, directives, open file/chat, focus; slots become GPUI components | agents |
| `widget_respond`, widget-context resource, `document_read_range` | PM positions (§2.8) | agents + editor |
| `core.documents.write/read/beginMove/whenWritesSettled` | agent writes adopt into the open editor (§2.5) | editor |
| `turnWrites.attribute(path, hash)` | `agent:tool-call` and `agent:turn-settled` hooks | editor ↔ agents |
| `core.promptRounds`, review-range store | persisted rounds and ranges | agents/db |
| Files and watcher | content rows (hash, content), `files.file(path).write`, echo suppression | shell |
| Tabs and focus | `EditorsApi` (register, instance, goTo, whenMounted), TabController, focus arbiter | shell |
| History repo | checkpoints per turn; a restore arrives as `documents.write` | git |
| Dictation | `DictationHost.attach(target)`, partial and final insertions | shell |

### 5.9 Suggested sequencing

1. **Week 0–1:** audit gpui-kit-markdown-editor against §5.1a and run the GPUI checks in §5.3. Build a 2-day prototype: one paragraph with marks, IME and caret on the fork.
2. **Weeks 1–6:** model alignment (PM positions), codec, golden corpus. Gate: byte parity on the corpus.
3. **Weeks 4–14:** view, caret, IME, clipboard. Gate: typing in the 8k doc under 8 ms a frame.
4. **Weeks 10–18:** sync and adoption, prompt widget core, toolbar and links. MVP gate: dogfood with agents writing into open documents.
5. **After MVP:** the parity table in this order: tables, the widget remainder, diff card, popups, frontmatter popover, RTL, spellcheck, other platforms.
