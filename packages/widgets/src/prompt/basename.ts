/**
 * Last path segment, for display only.
 *
 * Deliberately not the host's path flavor: this is used for tool-call
 * labels and file chips, where the input is whatever string a harness put in
 * a tool location — which can carry either separator regardless of the
 * platform the app runs on. Splitting on both is more correct here than
 * asking the app which one it prefers, and it keeps the derivations in
 * state.ts pure and host-free.
 */
export function basename(filePath: string): string {
  if (!filePath) return "";
  const segments = filePath.split(/[\\/]/);
  return segments[segments.length - 1] || filePath;
}
