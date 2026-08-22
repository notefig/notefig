/**
 * Focuses (opening if necessary) the document containing a blob and scrolls
 * its rendered widget into view. Blobs have no natural line/column position
 * (unlike file locations elsewhere in the app), so this targets the
 * `data-blob-id` attribute BlobNodeView already sets on its wrapper instead
 * of computing a position.
 */
import { getProtocolContext } from "@/utils/drag-protocol";
import { requestTabFocus } from "@/tabs/tab-controllers";

const POLL_INTERVAL_MS = 50;
const MAX_POLL_ATTEMPTS = 40; // ~2s

export function jumpToBlob(path: string, blobId: string): void {
  getProtocolContext().openFile?.({ tabId: path, intent: "new-tab", moveIfOpen: true });
  requestTabFocus(path, { when: "when-mounted", reason: "jump-to-blob" });
  pollForBlob(blobId, 0);
}

function pollForBlob(blobId: string, attempt: number): void {
  const el = document.querySelector<HTMLElement>(`[data-blob-id="${cssEscape(blobId)}"]`);
  if (el) {
    el.scrollIntoView({ block: "center" });
    // Inline style, not a class: a dynamically-added class name wouldn't be
    // picked up by Tailwind's static JIT scan.
    const previousTransition = el.style.transition;
    const previousBoxShadow = el.style.boxShadow;
    el.style.transition = "box-shadow 0.2s ease";
    el.style.boxShadow = "0 0 0 2px var(--ring, #3b82f6)";
    setTimeout(() => {
      el.style.boxShadow = previousBoxShadow;
      setTimeout(() => {
        el.style.transition = previousTransition;
      }, 300);
    }, 1500);
    return;
  }
  if (attempt >= MAX_POLL_ATTEMPTS) return;
  setTimeout(() => pollForBlob(blobId, attempt + 1), POLL_INTERVAL_MS);
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value;
}
