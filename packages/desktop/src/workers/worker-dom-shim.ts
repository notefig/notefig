/**
 * Minimal DOM for the markdown conversion worker.
 *
 * The codec's dependencies touch the DOM in both directions:
 *  - tiptap-markdown's parser: `new window.DOMParser()`, `querySelectorAll`,
 *    `closest`, `Node.TEXT_NODE` (elementFromString / normalizeDOM)
 *  - serialization of html-mode marks/nodes: @tiptap/core's
 *    getHTMLFromFragment → `document.implementation.createHTMLDocument()`,
 *    and prosemirror-model's DOMSerializer → `window.document`
 *
 * linkedom's `/worker` build provides all of it without a browser. Installing
 * is a no-op when a real DOM exists, so codec code can import this
 * unconditionally and still run on the main thread (fallback path) or in
 * happy-dom tests.
 */

import {
  parseHTML,
  DOMParser,
  Node,
  HTMLElement,
  Element,
  Document,
  DocumentFragment,
  Text,
} from "linkedom/worker";

/**
 * Browsers imply the missing <html> element around fragments like
 * `<body>…</body>` (the wrapper tiptap-markdown and @tiptap/core both use);
 * linkedom parses such strings literally, yielding an empty body. Normalize
 * to a full document before handing off.
 */
class ShimDOMParser {
  private readonly inner = new DOMParser();

  parseFromString(html: string, mimeType: "text/html"): unknown {
    let value = html;
    if (mimeType === "text/html" && !/^\s*(<!doctype|<html)/i.test(value)) {
      value = /^\s*<body[\s>]/i.test(value)
        ? `<html>${value}</html>`
        : `<html><body>${value}</body></html>`;
    }
    return this.inner.parseFromString(value, mimeType);
  }
}

export function installWorkerDomShim(): void {
  if (typeof document !== "undefined") return;

  const { document: shimDocument } = parseHTML(
    "<!doctype html><html><head></head><body></body></html>",
  );

  // linkedom's worker build has no document.implementation; @tiptap/core's
  // getHTMLFromFragment needs createHTMLDocument() as a scratch document for
  // serializing html-mode marks/nodes (underline, highlight, sub, sup, …).
  if (!(shimDocument as unknown as { implementation?: unknown }).implementation) {
    (shimDocument as unknown as Record<string, unknown>).implementation = {
      createHTMLDocument: () =>
        parseHTML("<!doctype html><html><head></head><body></body></html>")
          .document,
    };
  }

  const g = globalThis as Record<string, unknown>;
  g.document = shimDocument;
  g.DOMParser = ShimDOMParser;
  g.Node = Node;
  g.HTMLElement = HTMLElement;
  g.Element = Element;
  g.Document = Document;
  g.DocumentFragment = DocumentFragment;
  g.Text = Text;

  // elementFromString does `new window.DOMParser()`; DOMSerializer falls back
  // to `window.document`. A plain object keeps the wrapped DOMParser in
  // control instead of linkedom's defaultView proxy.
  g.window = { document: shimDocument, DOMParser: ShimDOMParser, Node };
}
