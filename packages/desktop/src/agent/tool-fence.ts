import { parse as parseYaml } from "yaml";

/**
 * Detects `metrists:tool` fences in coalesced assistant text (per the Stage
 * 0 spike's validated format — docs/architecture/spikes/v2-tool-fence-spike.md):
 *
 * ```metrists:tool
 * name: <tool_name>
 * input:
 *   <yaml-object matching the tool's input schema>
 * ```
 *
 * Pure/stateless: re-scan the accumulating `turn.text` after each
 * `agent_message_chunk` append (see agent-service.ts). A fence's opening and
 * interior lines stream in incrementally, but this function only returns a
 * result once a complete fence (or a clearly-unclosed one) is visible —
 * callers must not act on a `null` result as "no fence was ever attempted."
 */

const FENCE_PATTERN = /```metrists:tool\n([\s\S]*?)\n```/;
const OPEN_FENCE_PATTERN = /```metrists:tool\n/;

export type FenceMatch = { name: string; input: unknown; raw: string };
export type FenceScanResult =
  | { kind: "none" }
  | { kind: "incomplete" }
  | { kind: "malformed"; raw: string; reason: string }
  | ({ kind: "match" } & FenceMatch);

export function findToolFence(text: string): FenceScanResult {
  const complete = FENCE_PATTERN.exec(text);
  if (complete) {
    return parseFenceBody(complete[1], complete[0]);
  }
  if (OPEN_FENCE_PATTERN.test(text)) {
    return { kind: "incomplete" };
  }
  return { kind: "none" };
}

function parseFenceBody(body: string, raw: string): FenceScanResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(body);
  } catch (error) {
    return {
      kind: "malformed",
      raw,
      reason: `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { name?: unknown }).name !== "string"
  ) {
    return { kind: "malformed", raw, reason: "missing required `name` field" };
  }
  const { name, input } = parsed as { name: string; input?: unknown };
  return { kind: "match", name, input: input ?? {}, raw };
}
