/**
 * The web-mode asymmetry lives here: fs/* and terminal/* ACP client-methods
 * are answered locally by the worker (the bytes are on this machine), while
 * session/request_permission and session/update pass through to the browser.
 *
 * Input: one JSON-RPC line from the harness. Output: either a response line
 * to write straight back to the harness (handled locally) or null (forward
 * to the browser over the tunnel).
 */
export type InterceptResult =
  | { handled: true; responseLine: string }
  | { handled: false };

export async function interceptAgentLine(
  _line: string,
  _workspaceDir: string,
): Promise<InterceptResult> {
  // TODO(phase 3): parse JSON-RPC; handle fs/read_text_file,
  // fs/write_text_file (and terminal/* in phase 4) against workspaceDir;
  // everything else passes through.
  throw new Error('not implemented: interceptAgentLine');
}
