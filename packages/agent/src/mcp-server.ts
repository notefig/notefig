import { zodToJsonSchema } from "zod-to-json-schema";
import { MCP_SERVER_NAME, newEventId } from "@notefig/shared/agent";
import type { AgentTool, ToolContext } from "./tool-types";
import type { PermissionRequester } from "./permission-requester";
import type { McpEndpoint, Unsubscribe } from "./agent-transport.interface";
import {
  decodeWidgetContextUri,
  type WidgetContextRef,
} from "./widget-context-uri";

/**
 * `zod-to-json-schema` resolves hoisted at the workspace root against a
 * different physical `zod` install than the one desktop's own package.json
 * nests locally (root has zod@4 with a v3 compat shim; desktop pins real
 * zod@3) — two structurally enormous but nominally distinct `ZodTypeAny`
 * types, which sends plain `zodToJsonSchema(schema, …)` into TS2589
 * ("excessively deep"). Routing the schema through `unknown` first is a
 * value-level no-op (same object at runtime) that skips the structural
 * comparison TS would otherwise attempt between the two identities.
 */
export function toJsonSchema(schema: unknown): unknown {
  return zodToJsonSchema(schema as Parameters<typeof zodToJsonSchema>[0], {
    $refStrategy: "none",
  });
}

export type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function jsonrpcResult(
  id: JsonRpcMessage["id"],
  result: unknown,
): JsonRpcMessage {
  return { jsonrpc: "2.0", id, result };
}

function jsonrpcError(
  id: JsonRpcMessage["id"],
  code: number,
  message: string,
): JsonRpcMessage {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** A tool's hand-rendered schema wins over the generic zod rendering — see
 *  `AgentTool.inputJsonSchema` (author_blob's blob-type `anyOf` lives with
 *  the tool, in desktop). */
function toolInputJsonSchema(tool: AgentTool<unknown, unknown>): unknown {
  return tool.inputJsonSchema?.() ?? toJsonSchema(tool.input);
}

/**
 * Permission gate + execute, extracted from Stage 2's `executeFenceTool` now
 * that it has a second (only) caller: `tools/call` below. Same broker call
 * shape as the fence path used.
 */
async function dispatchToolCall(
  tool: AgentTool<unknown, unknown>,
  deps: McpHandlerDeps,
  input: unknown,
): Promise<JsonRpcMessage["result"] | { isError: true; content: unknown[] }> {
  const ctx = deps.ctx;
  if (tool.requiresPermission) {
    const response = await deps.permissionBroker.request({
      sessionId: ctx.taskId,
      // newEventId: unique even for same-millisecond calls (Date.now() collides).
      toolCall: { toolCallId: newEventId(), title: deps.translate(tool.title) },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    const outcome = response.outcome;
    const denied =
      outcome.outcome === "cancelled" ||
      (outcome.outcome === "selected" && outcome.optionId === "deny");
    if (denied) {
      return {
        isError: true,
        content: [
          { type: "text", text: `permission denied for "${tool.name}"` },
        ],
      };
    }
  }

  const result = await tool.execute(ctx, input);
  return result.ok
    ? { content: [{ type: "text", text: JSON.stringify(result.value) }] }
    : { isError: true, content: [{ type: "text", text: result.error }] };
}

/**
 * If any top-level value of `args` is a string that itself parses as a JSON
 * object/array, return a copy with those values parsed; undefined when
 * nothing qualified (caller keeps the original failure).
 */
function parseStringifiedObjectValues(
  args: unknown,
): Record<string, unknown> | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args))
    return undefined;
  let repairedAny = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && /^\s*[[{]/.test(value)) {
      try {
        out[key] = JSON.parse(value);
        repairedAny = true;
        continue;
      } catch {
        // fall through, keep the original string
      }
    }
    out[key] = value;
  }
  return repairedAny ? out : undefined;
}

/**
 * Spec revisions this handler is verified against, newest first —
 * negotiation falls back to [0]. Don't add a revision without checking its
 * changelog against our surface (initialize, ping, tools/list, tools/call,
 * resources/list, resources/read). Verified 2026-08-20:
 * - 2025-11-25: additive only (auth discovery, icons, elicitation, sampling
 *   tools, experimental tasks). The one item touching us is SEP-1303, a
 *   SHOULD-level clarification that tool input-validation errors go back as
 *   tool execution errors rather than protocol errors; we still answer
 *   -32602 after the repair pass, which remains compliant.
 * - 2025-06-18: removed JSON-RPC batching (we never batched), structured
 *   tool output + elicitation are optional additions.
 * - 2025-03-26: streamable HTTP + audio content — transport/content
 *   features we don't emit.
 * Real harnesses bundle the official MCP SDK, which requests the latest
 * revision it knows and validates our counter-offer against its own
 * supported list (opencode's binary carries all four of these strings).
 */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

/**
 * MCP version negotiation (spec: lifecycle § initialization): echo the
 * requested revision if we support it, otherwise offer our latest and let
 * the client decide whether to proceed or disconnect. Replaces the old
 * verbatim echo, which claimed support for anything (MET-153).
 */
export function negotiateMcpProtocolVersion(
  requested: string | undefined,
): string {
  return requested &&
    (SUPPORTED_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : SUPPORTED_MCP_PROTOCOL_VERSIONS[0];
}

export type McpHandlerDeps = {
  ctx: ToolContext;
  permissionBroker: PermissionRequester;
  /** The app's tool registry: `list` drives tools/list, `get` tools/call. */
  tools: {
    list(): readonly AgentTool<unknown, unknown>[];
    get(name: string): AgentTool<unknown, unknown> | undefined;
  };
  /** `tool.title` holds an i18next key, never literal text — resolved at
   *  the point of use so it reflects the active language even if it changes
   *  after the tool registry module first loaded. */
  translate: (key: string) => string;
  /**
   * Product copy for `initialize.instructions` — tool-steering text that
   * rides MCP's own channel so only sessions that actually have this server
   * hear about its tools (vs the old unconditional first-turn preamble).
   * The copy describes the app's tools, so the app owns it (desktop:
   * mcp-instructions.ts).
   */
  instructions: () => string;
  /** resources/read payload builder for a decoded widget-context ref (the
   *  builder reads live editor state, so it lives with the app). */
  buildWidgetContextPayload: (
    workspacePath: string,
    ref: WidgetContextRef,
  ) => Promise<unknown>;
  /** Fired when a client requests a revision outside our supported list
   *  (undefined = it sent none) and gets counter-offered our latest —
   *  observability hook (desktop wires telemetry); never affects the
   *  response. */
  onUnsupportedProtocolVersion?: (requested: string | undefined) => void;
};

function handleInitialize(
  deps: McpHandlerDeps,
  id: JsonRpcMessage["id"],
  params: unknown,
): JsonRpcMessage {
  const requested = (params as { protocolVersion?: string } | undefined)
    ?.protocolVersion;
  const negotiated = negotiateMcpProtocolVersion(requested);
  if (negotiated !== requested) {
    deps.onUnsupportedProtocolVersion?.(requested);
  }
  return jsonrpcResult(id, {
    protocolVersion: negotiated,
    capabilities: { tools: {}, resources: {} },
    serverInfo: { name: MCP_SERVER_NAME, version: "1.0.0" },
    instructions: deps.instructions(),
  });
}

function handleToolsList(
  deps: McpHandlerDeps,
  id: JsonRpcMessage["id"],
): JsonRpcMessage {
  return jsonrpcResult(id, {
    tools: deps.tools.list().map((tool) => ({
      name: tool.name,
      title: deps.translate(tool.title),
      description: tool.description,
      inputSchema: toolInputJsonSchema(tool),
    })),
  });
}

async function handleResourcesRead(
  deps: McpHandlerDeps,
  id: JsonRpcMessage["id"],
  params: unknown,
): Promise<JsonRpcMessage> {
  const uri = (params as { uri?: string } | undefined)?.uri;
  const ref = typeof uri === "string" ? decodeWidgetContextUri(uri) : undefined;
  if (!ref || !uri) {
    return jsonrpcError(
      id,
      -32602,
      `unknown resource uri: ${uri ?? "(missing)"}`,
    );
  }
  const payload = await deps.buildWidgetContextPayload(
    deps.ctx.workspacePath,
    ref,
  );
  return jsonrpcResult(id, {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  });
}

async function handleToolsCall(
  deps: McpHandlerDeps,
  id: JsonRpcMessage["id"],
  params: unknown,
): Promise<JsonRpcMessage> {
  const callParams = params as
    | { name?: string; arguments?: unknown }
    | undefined;
  const name = callParams?.name;
  const tool = name ? deps.tools.get(name) : undefined;
  if (!tool) {
    return jsonrpcError(
      id,
      -32602,
      `unknown tool: ${name ?? "(missing name)"}`,
    );
  }
  const args = callParams?.arguments ?? {};
  let parsed = tool.input.safeParse(args);
  if (!parsed.success) {
    // One repair pass: OpenCode has been observed delivering a nested
    // object argument as its JSON *string* ("payload": "{\"kind\":…}",
    // v2-opencode-config-mcp-spike.md). Re-parse stringified
    // object/array values and retry before rejecting.
    const repaired = parseStringifiedObjectValues(args);
    if (repaired) parsed = tool.input.safeParse(repaired);
  }
  if (!parsed.success) {
    return jsonrpcError(
      id,
      -32602,
      `invalid input for ${tool.name}: ${parsed.error.message}`,
    );
  }
  const result = await dispatchToolCall(tool, deps, parsed.data);
  return jsonrpcResult(id, result);
}

/**
 * Stateless MCP request handler (initialize/tools.list/tools.call), bound to
 * one task's `ToolContext` + `PermissionRequester`. Transport-agnostic — it
 * takes a parsed JSON-RPC object and returns one back, and knows nothing
 * about ports, processes, or sockets. `attachMcpEndpoint` below is what
 * puts it on the wire.
 */
export function createMcpRequestHandler(
  deps: McpHandlerDeps,
): (body: JsonRpcMessage) => Promise<JsonRpcMessage | null> {
  return async function handleMcpRequest(
    body: JsonRpcMessage,
  ): Promise<JsonRpcMessage | null> {
    const { id, method, params } = body;

    switch (method) {
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "initialize":
        return handleInitialize(deps, id, params);
      case "ping":
        return jsonrpcResult(id, {});
      case "tools/list":
        return handleToolsList(deps, id);
      case "resources/list":
        // Widget-context resources are self-contained URIs handed directly
        // to the agent inside the prompt's own resource_link — nothing
        // upfront to enumerate (no server-side registry; see
        // widget-context-uri.ts).
        return jsonrpcResult(id, { resources: [] });
      case "resources/read":
        return handleResourcesRead(deps, id, params);
      case "tools/call":
        return handleToolsCall(deps, id, params);
      default:
        return jsonrpcError(id, -32601, `method not found: ${method}`);
    }
  };
}

/**
 * Puts a `handleMcpRequest` function on an `McpEndpoint`'s wire: an MCP
 * request is one line in, our response goes out through that request's own
 * `respond` — which the endpoint has already bound to the connection the
 * request arrived on, so multi-instance harnesses (OpenCode runs the server
 * command three times concurrently) can never receive each other's replies.
 * No request/response correlation needed beyond that — MCP's own JSON-RPC
 * `id` is what the *harness* uses to match a response to its request.
 *
 * Version seam: if a future spec revision ever forces divergent behavior,
 * per-version handler variants would key HERE, at the connection level —
 * each connection sees exactly one `initialize`, so this is where the
 * negotiated version is knowable — not inside the shared stateless handler.
 */
export function attachMcpEndpoint(
  endpoint: McpEndpoint,
  handler: (body: JsonRpcMessage) => Promise<JsonRpcMessage | null>,
): Unsubscribe {
  return endpoint.onRequest((line, respond) => {
    void (async () => {
      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(line) as JsonRpcMessage;
      } catch (error) {
        respond(
          JSON.stringify(
            jsonrpcError(
              null,
              -32700,
              error instanceof Error ? error.message : String(error),
            ),
          ),
        );
        return;
      }
      const response = await handler(parsed);
      if (response) respond(JSON.stringify(response));
    })();
  });
}
