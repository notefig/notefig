/**
 * The one clipboard write path. `navigator.clipboard` needs a secure
 * context and a permission grant; when it rejects, the hidden-textarea
 * `execCommand("copy")` dance still works everywhere the app runs.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const el = document.createElement("textarea");
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  }
}
