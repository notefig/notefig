/**
 * Rewrite a widget's marker comments into the element its `parseHTML`
 * matches — the parse hook every comment-persisted widget shares.
 *
 * This hook is the last moment the comments exist: markdown-it emits them
 * verbatim (html: true) and DOMParser keeps them, but ProseMirror's own
 * DOMParser handles only element and text nodes, so anything still a comment
 * by then is dropped without a trace.
 *
 * A manual childNodes recursion rather than querySelectorAll (which cannot
 * select comments) or a TreeWalker (which the conversion worker's linkedom
 * shim does not expose) — plain childNodes works in both DOMs.
 *
 * A repeated marker (an agent rewriting the file can copy it) is dropped:
 * every widget keys its state by blobId, so a second one would share the
 * first's. Only the first copy becomes a widget.
 *
 * `parse` reads a comment's data into the replacement's `data-*`
 * attributes (string fields, camelCase keys: `taskId` → `data-task-id`), or
 * null for a comment that isn't this widget's.
 */
export function replaceMarkerComments(
  element: HTMLElement,
  dataType: string,
  parse: (data: string) => { blobId: string } | null,
): void {
  const COMMENT_NODE = 8;
  const ELEMENT_NODE = 1;
  const seen = new Set<string>();
  const walk = (parent: Node): void => {
    // Snapshot: replaceChild mutates the live childNodes list.
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === ELEMENT_NODE) {
        walk(child);
        continue;
      }
      if (child.nodeType !== COMMENT_NODE) continue;
      const marker = parse((child as unknown as { data: string }).data ?? "");
      if (!marker) continue;
      if (seen.has(marker.blobId)) {
        parent.removeChild(child);
        continue;
      }
      seen.add(marker.blobId);
      const doc = element.ownerDocument;
      if (!doc) continue;
      const replacement = doc.createElement("div");
      replacement.setAttribute("data-type", dataType);
      for (const [key, value] of Object.entries(marker)) {
        const name = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
        replacement.setAttribute(`data-${name}`, value);
      }
      parent.replaceChild(replacement, child);
    }
  };
  walk(element);
}
