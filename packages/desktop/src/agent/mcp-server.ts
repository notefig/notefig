import { zodToJsonSchema } from "zod-to-json-schema";
import type { AgentTool, ToolContext } from "@metrists/shared/agent";
import { getAllBlobTypes } from "@/components/editor/blobs/blob-registry";
import { toolRegistry, getTool } from "./tools";
import type { PermissionBroker } from "./permission-broker";
import type { AgentTransport, Unsubscribe } from "./agent-transport.interface";
import i18n from "@/utils/intl";

/** `tool.title` holds an i18next key, never literal text — resolve it here,
 *  at the point of use, so it reflects the active language even if it
 *  changes after the tool registry module first loaded. */
function toolTitle(tool: Pick<AgentTool<unknown, unknown>, "title">): string {
  return i18n.t(tool.title);
}

/** The MCP server name Stage 3.5's `session/new.mcpServers` entry advertises;
 *  also the prefix adapters mint tool names under (`mcp__metrists__<tool>`). */
export const MCP_SERVER_NAME = "metrists";

/**
 * MCP's `tools/list` schema is enough for the model to call a tool
 * correctly, but not enough to make it *reach* for one — a real session
 * defaulted to native Read/cat/Write for workspace files and wrote plain
 * text instead of calling `author_blob` for an explicit "add a question"
 * request, only using the MCP tools once told to directly. One short
 * steering nudge, sent once per task (`agent-service.ts`'s first turn),
 * fixes the preference without re-describing any schema the MCP layer
 * already covers.
 */
export function renderToolUsagePreamble(): string {
  const names = toolRegistry.map((tool) => tool.name).join(", ");
  return (
    `You have Metrists-native tools available via MCP (${names}). Prefer these ` +
    `over generic file-read/write or shell tools when working with this workspace's ` +
    `documents — they see live editor state (unsaved edits, open tabs) and document ` +
    `history that generic tools don't. In particular, use \`author_blob\` whenever the ` +
    `user asks you to add an interactive question, approval, or status block to a ` +
    `document — not plain text — it renders as an answerable widget, and you'll get a ` +
    `follow-up prompt with the user's answer once they respond.`
  );
}

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
function toJsonSchema(schema: unknown): unknown {
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

function jsonrpcResult(id: JsonRpcMessage["id"], result: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", id, result };
}

function jsonrpcError(
  id: JsonRpcMessage["id"],
  code: number,
  message: string,
): JsonRpcMessage {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * `author_blob`'s input is `{ path, type, id, payload }` where `payload`'s
 * shape depends on `type` — the exact envelope/payload split that caused
 * the seven-guess fence failure (docs/architecture/agent-harness-v2.md,
 * "Findings"). A generic `zodToJsonSchema(tool.input)` only sees
 * `payload: z.record(z.unknown())`, which is no more informative than the
 * old prose description. Render it explicitly instead, `anyOf` over every
 * registered blob type's real payload schema, regenerated per call so blob
 * registration timing is a non-issue.
 */
function authorBlobInputJsonSchema(): unknown {
  const blobTypes = getAllBlobTypes();
  const payloadSchemas = blobTypes.map((blobType) => toJsonSchema(blobType.schema));
  return {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative document path." },
      type: {
        type: "string",
        enum: blobTypes.map((t) => t.type),
        description: "Which registered blob type to author.",
      },
      id: {
        type: "string",
        pattern: "^[a-z]+_[a-z0-9]{4,}$",
        description: 'Unique block id, e.g. "question_8f2a".',
      },
      payload: {
        description: "Shape depends on `type` — matches the corresponding entry below.",
        anyOf: payloadSchemas,
      },
    },
    required: ["path", "type", "id"],
  };
}

function toolInputJsonSchema(tool: AgentTool<unknown, unknown>): unknown {
  return tool.name === "author_blob" ? authorBlobInputJsonSchema() : toJsonSchema(tool.input);
}

/**
 * Permission gate + execute, extracted from Stage 2's `executeFenceTool` now
 * that it has a second (only) caller: `tools/call` below. Same broker call
 * shape as the fence path used.
 */
async function dispatchToolCall(
  tool: AgentTool<unknown, unknown>,
  ctx: ToolContext,
  permissionBroker: PermissionBroker,
  input: unknown,
): Promise<JsonRpcMessage["result"] | { isError: true; content: unknown[] }> {
  if (tool.requiresPermission) {
    const response = await permissionBroker.request({
      sessionId: ctx.taskId,
      toolCall: { toolCallId: `mcp_${Date.now()}`, title: toolTitle(tool) },
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
        content: [{ type: "text", text: `permission denied for "${tool.name}"` }],
      };
    }
  }

  const result = await tool.execute(ctx, input);
  return result.ok
    ? { content: [{ type: "text", text: JSON.stringify(result.value) }] }
    : { isError: true, content: [{ type: "text", text: result.error }] };
}

export type McpHandlerDeps = {
  ctx: ToolContext;
  permissionBroker: PermissionBroker;
};

/**
 * Stateless MCP request handler (initialize/tools.list/tools.call), bound to
 * one task's `ToolContext` + `PermissionBroker`. Transport-agnostic — it
 * takes a parsed JSON-RPC object and returns one back, and knows nothing
 * about ports, processes, or sockets. `attachMcpTransport` below is what
 * puts it on the wire.
 */
export function createMcpRequestHandler(
  deps: McpHandlerDeps,
): (body: JsonRpcMessage) => Promise<JsonRpcMessage | null> {
  return async function handleMcpRequest(body: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    const { id, method, params } = body;

    if (method === "notifications/initialized" || method === "notifications/cancelled") {
      return null;
    }

    if (method === "initialize") {
      return jsonrpcResult(id, {
        protocolVersion:
          (params as { protocolVersion?: string } | undefined)?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: "1.0.0" },
      });
    }

    if (method === "ping") {
      return jsonrpcResult(id, {});
    }

    if (method === "tools/list") {
      return jsonrpcResult(id, {
        tools: toolRegistry.map((tool) => ({
          name: tool.name,
          title: toolTitle(tool),
          description: tool.description,
          inputSchema: toolInputJsonSchema(tool),
        })),
      });
    }

    if (method === "tools/call") {
      const callParams = params as { name?: string; arguments?: unknown } | undefined;
      const name = callParams?.name;
      const tool = name ? getTool(name) : undefined;
      if (!tool) {
        return jsonrpcError(id, -32602, `unknown tool: ${name ?? "(missing name)"}`);
      }
      const parsed = tool.input.safeParse(callParams?.arguments ?? {});
      if (!parsed.success) {
        return jsonrpcError(id, -32602, `invalid input for ${tool.name}: ${parsed.error.message}`);
      }
      const result = await dispatchToolCall(tool, deps.ctx, deps.permissionBroker, parsed.data);
      return jsonrpcResult(id, result);
    }

    return jsonrpcError(id, -32601, `method not found: ${method}`);
  };
}

/**
 * Puts a `handleMcpRequest` function on the wire over an `AgentTransport` —
 * the same line-channel shape `MetristsAcpClient` rides for the ACP
 * connection, applied here too (`tauri-mcp-transport.ts`): once the
 * harness-spawned relay connects, an MCP request is just another line in,
 * and our response is just another line out. No request/response
 * correlation needed on either end — MCP's own JSON-RPC `id` is what the
 * *harness* uses to match a response to its request; we only ever have one
 * request in flight per line anyway.
 */
export function attachMcpTransport(
  transport: AgentTransport,
  handler: (body: JsonRpcMessage) => Promise<JsonRpcMessage | null>,
): Unsubscribe {
  return transport.onLine((line) => {
    void (async () => {
      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(line) as JsonRpcMessage;
      } catch (error) {
        transport.send(
          JSON.stringify(
            jsonrpcError(null, -32700, error instanceof Error ? error.message : String(error)),
          ),
        );
        return;
      }
      const response = await handler(parsed);
      if (response) transport.send(JSON.stringify(response));
    })();
  });
}
