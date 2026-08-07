import { zodToJsonSchema } from "zod-to-json-schema";
import {
  MCP_SERVER_NAME,
  newEventId,
  type AgentTool,
  type ToolContext,
} from "@metrists/shared/agent";
import { getAllBlobTypes } from "@/components/editor/blobs/blob-registry";
import { toolRegistry, getTool } from "./tools";
import type { PermissionBroker } from "./permission-broker";
import type { McpEndpoint, Unsubscribe } from "./agent-transport.interface";
import i18n from "@/utils/intl";
import { buildWidgetContextPayload } from "./widget-context-resource";
import { decodeWidgetContextUri } from "./widget-context-uri";

/** `tool.title` holds an i18next key, never literal text — resolve it here,
 *  at the point of use, so it reflects the active language even if it
 *  changes after the tool registry module first loaded. */
function toolTitle(tool: Pick<AgentTool<unknown, unknown>, "title">): string {
  return i18n.t(tool.title);
}

/**
 * MCP's `tools/list` schema is enough for the model to call a tool
 * correctly, but not enough to make it *reach* for one — a real session
 * defaulted to native Read/cat/Write for workspace files and wrote plain
 * text instead of calling `author_blob` for an explicit "add a question"
 * request, only using the MCP tools once told to directly. This steering
 * text rides MCP's own channel for exactly that purpose —
 * `initialize.instructions` — instead of a prompt preamble: the server
 * describes itself, so only sessions that actually have the server hear
 * about its tools (the old first-turn preamble was sent unconditionally,
 * telling `mcpRegistration: "none"` harnesses and failed-registration
 * tasks about tools that didn't exist).
 */
function serverInstructions(): string {
  const names = toolRegistry.map((tool) => tool.name).join(", ");
  return (
    `This server exposes the Notefig writing app's native tools (${names}) — ` +
    `you are running as an agent inside that app. Notefig registers this server ` +
    `automatically for the session via a per-task, ephemeral config — it will not ` +
    `appear in your global or project config files, and you don't need to locate ` +
    `or verify it. Four of these are your PRIMARY tools — keep them top of mind; ` +
    `everything else is secondary, for when the task specifically calls for it. ` +
    `(1) The widget-context resource: a prompt sent from an in-document widget ` +
    `always carries a \`resource_link\` — call \`resources/read\` on its URI as ` +
    `your FIRST action, before \`workspace_read_document\` or any native ` +
    `file-read tool. Its payload (document title, the full heading outline, the ` +
    `text surrounding the prompt's position, the current selection, and the other ` +
    `files open in the workspace) is deliberately sized to be enough context to ` +
    `act on most requests directly — treat it as your default context, not an ` +
    `optional extra. ` +
    `(2) \`widget_respond\`: when a prompt carries that widget-context ` +
    `resource_link, you MUST deliver your final response by calling ` +
    `\`widget_respond\` before ending the turn — kind "answer" for the response ` +
    `itself, kind "issue" if you hit a blocker or need to flag a problem. This ` +
    `holds ESPECIALLY for turns that need no tool actions at all: a widget prompt ` +
    `answered with prose alone still ends with \`widget_respond\` — for widget ` +
    `prompts, plain assistant text is progress notes, never the deliverable. When ` +
    `a prompt has no resource_link (it came from the chat panel), do NOT call ` +
    `\`widget_respond\` — answer in chat as normal. ` +
    `(3) \`author_blob\` with a multiple-choice question: whenever you need the ` +
    `user to decide or clarify something — or they ask you to add an interactive ` +
    `question, approval, or status block to a document — author a block instead ` +
    `of asking in prose. It renders as an answerable widget, and you'll get a ` +
    `follow-up prompt with the user's answer once they respond — don't re-ask or ` +
    `wait synchronously. ` +
    `(4) \`workspace_read_document\`: the fallback when the widget context ` +
    `genuinely doesn't cover what the request needs — e.g. editing a different ` +
    `section you can see named in the outline but whose text isn't in the ` +
    `surrounding-text window. Do NOT read the entire document by default: that ` +
    `wastes context on documents where the request only concerns a few paragraphs ` +
    `— prefer a partial read with \`line\`/\`limit\`. ` +
    `Prefer all of these tools over generic file-read/write or shell tools when ` +
    `working with this workspace's documents — they see live editor state ` +
    `(unsaved edits, open tabs) and document history that generic tools don't. ` +
    `Most requests that reference a document — including anything phrased as an ` +
    `instruction about "this section" or "this doc" — expect you to edit the ` +
    `document directly with your editing tools, not to reply with prose ` +
    `describing what you would do; treat the document named in that resource ` +
    `payload as the default subject unless the user is clearly asking a question ` +
    `instead.`
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
  const payloadSchemas = blobTypes.map((blobType) =>
    toJsonSchema(blobType.schema),
  );
  return {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative document path.",
      },
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
        description:
          "Shape depends on `type` — matches the corresponding entry below.",
        anyOf: payloadSchemas,
      },
    },
    required: ["path", "type", "id"],
  };
}

function toolInputJsonSchema(tool: AgentTool<unknown, unknown>): unknown {
  return tool.name === "author_blob"
    ? authorBlobInputJsonSchema()
    : toJsonSchema(tool.input);
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
      // newEventId: unique even for same-millisecond calls (Date.now() collides).
      toolCall: { toolCallId: newEventId(), title: toolTitle(tool) },
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

export type McpHandlerDeps = {
  ctx: ToolContext;
  permissionBroker: PermissionBroker;
};

/**
 * Stateless MCP request handler (initialize/tools.list/tools.call), bound to
 * one task's `ToolContext` + `PermissionBroker`. Transport-agnostic — it
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

    if (
      method === "notifications/initialized" ||
      method === "notifications/cancelled"
    ) {
      return null;
    }

    if (method === "initialize") {
      return jsonrpcResult(id, {
        protocolVersion:
          (params as { protocolVersion?: string } | undefined)
            ?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: "1.0.0" },
        instructions: serverInstructions(),
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

    if (method === "resources/list") {
      // Widget-context resources are self-contained URIs handed directly to
      // the agent inside the prompt's own resource_link — nothing upfront
      // to enumerate (no server-side registry; see widget-context-uri.ts).
      return jsonrpcResult(id, { resources: [] });
    }

    if (method === "resources/read") {
      const uri = (params as { uri?: string } | undefined)?.uri;
      const ref =
        typeof uri === "string" ? decodeWidgetContextUri(uri) : undefined;
      if (!ref || !uri) {
        return jsonrpcError(
          id,
          -32602,
          `unknown resource uri: ${uri ?? "(missing)"}`,
        );
      }
      const payload = await buildWidgetContextPayload(
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

    if (method === "tools/call") {
      const callParams = params as
        | { name?: string; arguments?: unknown }
        | undefined;
      const name = callParams?.name;
      const tool = name ? getTool(name) : undefined;
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
      const result = await dispatchToolCall(
        tool,
        deps.ctx,
        deps.permissionBroker,
        parsed.data,
      );
      return jsonrpcResult(id, result);
    }

    return jsonrpcError(id, -32601, `method not found: ${method}`);
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
