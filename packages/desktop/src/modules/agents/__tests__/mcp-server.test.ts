import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// The document tools read/write through the task's documents; fake them so
// dispatch never touches a real workspace.
const readWorkspaceTextFile = vi.fn(async (_path: string) => "# Doc\n");
const writeWorkspaceTextFile = vi.fn(
  async (_path: string, _content: string) => {},
);

// The payload builder is an injected dep of the handler now (it reads live
// editor state, so the real one stays out of this suite); URI decoding is
// the package's own pure codec and runs for real.
const buildWidgetContextPayload = vi.fn();

import {
  attachMcpEndpoint,
  createMcpRequestHandler,
  encodeWidgetContextUri,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
} from "@notefig/agent";
import type { AgentTool, McpEndpoint, ToolContext } from "@notefig/agent";
import { PermissionBroker } from "../permission-broker";
import type { AgentStore } from "../agent-collections";
import { toolRegistry, getTool } from "../tools";
import { serverInstructions } from "../mcp-instructions";
import { WIDGET_RESPONSE_KINDS } from "@notefig/shared/agent";
import i18n from "@/utils/intl";
import { createLayout } from "@/modules/layout";
import { memoryUrlState } from "@/testing/test-core";
import { testAgentStore } from "@/testing/test-agents";

const ctx: ToolContext = {
  workspacePath: "/ws",
  taskId: "task_mcp_1",
  agents: {
    task: () => ({ prompt: vi.fn(), cancel: vi.fn() }),
    workspace: () => ({ createTask: vi.fn() }),
  },
  services: {
    documents: { read: readWorkspaceTextFile, write: writeWorkspaceTextFile },
    // workspace_open_files reads the task's layout.
    layout: createLayout(memoryUrlState()),
  } as unknown as ToolContext["services"],
};

// The broker's permission requests, fresh per test.
let store: AgentStore;

/** A tool with a nested object argument, which no desktop tool has: the
 *  shape the OpenCode stringified-argument repair exists for. */
const nestedTool = {
  name: "nested_echo",
  title: "agentToolWidgetRespond",
  description: "Echo a nested payload.",
  input: z.object({ payload: z.object({ prompt: z.string() }) }),
  async execute(_ctx, input) {
    return { ok: true, value: input.payload };
  },
} satisfies AgentTool<{ payload: { prompt: string } }, { prompt: string }>;

/** A tool call that failed as a tool execution error: its message. */
function failure(response: { result?: unknown; error?: unknown } | null): string {
  expect(response?.error).toBeUndefined();
  const result = response?.result as { isError?: boolean; content: Array<{ text: string }> };
  expect(result.isError).toBe(true);
  return result.content[0].text;
}

/** The real registry plus the nested stub. */
const withNestedTool = {
  list: () => [...toolRegistry, nestedTool as unknown as AgentTool<unknown, unknown>],
  get: (name: string) =>
    name === nestedTool.name
      ? (nestedTool as unknown as AgentTool<unknown, unknown>)
      : getTool(name),
};

function handler(
  permissionBroker = new PermissionBroker(
    ctx.taskId,
    store.permissionRequests,
  ),
  tools: { list: () => readonly AgentTool<unknown, unknown>[]; get: typeof getTool } = {
    list: () => toolRegistry,
    get: getTool,
  },
) {
  return createMcpRequestHandler({
    ctx,
    permissionBroker,
    // The real desktop registry — this suite is deliberately an integration
    // test of the protocol handler against the actual tool set.
    tools,
    translate: (key) => i18n.t(key),
    instructions: serverInstructions,
    buildWidgetContextPayload,
  });
}

describe("createMcpRequestHandler", () => {
  beforeEach(() => {
    store = testAgentStore();
    buildWidgetContextPayload.mockReset();
  });

  it("initialize returns capabilities (including resources), server info, and tool-steering instructions", async () => {
    const response = await handler()({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        // No requested version → negotiation offers our latest (MET-153).
        protocolVersion: SUPPORTED_MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "notefig", version: "1.0.0" },
      },
    });
    const instructions = (response?.result as { instructions?: string })
      .instructions;
    // The steering text lives on the server's own channel (not a prompt
    // preamble) so only sessions that have the server hear about its tools.
    expect(instructions).toContain("widget_respond");
    expect(instructions).toContain("resources/read");
    // Steering is directive, not optional: resources/read first, and full
    // document reads are the fallback, not the default (context-size ask).
    expect(instructions).toContain("FIRST action");
    expect(instructions).toContain(
      "Do NOT read the entire document by default",
    );
    // MET-92: widget-originated prompts must land in the widget, not chat —
    // and the rule is directive (MET-68 finding: suggestions get ignored),
    // keyed off the resource_link so chat-originated prompts are untouched.
    expect(instructions).toContain("widget_respond");
    expect(instructions).toContain(
      "you MUST deliver your final response by calling `widget_respond`",
    );
    expect(instructions).toContain("do NOT call `widget_respond`");
    // Every response kind is named; the tool's description says when.
    for (const kind of Object.keys(WIDGET_RESPONSE_KINDS)) {
      expect(instructions).toContain(kind);
    }
  });

  it("resources/read: an undecodable uri returns a JSON-RPC error, not a thrown exception", async () => {
    const response = await handler()({
      jsonrpc: "2.0",
      id: 21,
      method: "resources/read",
      params: { uri: "notefig://widget-context?bogus=1" },
    });
    expect(response?.error?.code).toBe(-32602);
    expect(buildWidgetContextPayload).not.toHaveBeenCalled();
  });

  it("resources/read: a decodable uri returns the payload as JSON text content", async () => {
    const ref = { path: "notes.md", pos: 0 };
    const payload = {
      documentTitle: "Notes",
      documentPath: "notes.md",
      outline: [],
      position: { headingText: null },
      surroundingText: "",
      selectedText: null,
      otherOpenFiles: [],
    };
    buildWidgetContextPayload.mockResolvedValue(payload);

    const uri = encodeWidgetContextUri(ref);
    const response = await handler()({
      jsonrpc: "2.0",
      id: 22,
      method: "resources/read",
      params: { uri },
    });
    expect(buildWidgetContextPayload).toHaveBeenCalledWith(
      ctx.workspacePath,
      ref,
    );
    const result = response?.result as {
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    };
    expect(result.contents[0].uri).toBe(uri);
    expect(result.contents[0].mimeType).toBe("application/json");
    expect(JSON.parse(result.contents[0].text)).toEqual(payload);
  });

  it("notifications/initialized returns null (no response)", async () => {
    const response = await handler()({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(response).toBeNull();
  });

  it("tools/list includes every registered tool with a title and a JSON Schema", async () => {
    const response = await handler()({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const result = response?.result as {
      tools: Array<{ name: string; title: string; inputSchema: unknown }>;
    };
    const names = result.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "workspace_list_documents",
        "workspace_read_document",
        "workspace_open_files",
        "history_log",
        "history_diff",
        "history_checkpoint",
        "history_restore",
        "widget_respond",
      ]),
    );
    // Every tool has a human-readable title distinct from its snake_case name.
    expect(result.tools.every((t) => t.title && t.title !== t.name)).toBe(true);
  });

  // MET-92: execute is validate-and-acknowledge only — the tool_call
  // transcript entry the service writes is the record the widget derives
  // from (deriveWidgetResponse), so there's no state to assert here beyond
  // the ack round-trip and the schema gate.
  it("tools/call: widget_respond acknowledges valid input and rejects a bad kind", async () => {
    const ok = await handler()({
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: {
        name: "widget_respond",
        arguments: { kind: "answer", markdown: "Two options stand out." },
      },
    });
    const result = ok?.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(JSON.parse(result.content[0].text)).toEqual({ recorded: true });

    const bad = await handler()({
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: {
        name: "widget_respond",
        arguments: { kind: "summary", markdown: "x" },
      },
    });
    expect(failure(bad)).toContain("invalid input for widget_respond");

    // Past a limit, the call fails with what to fix, for the agent to retry.
    const long = await handler()({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: {
        name: "widget_respond",
        arguments: {
          kind: "single_choice",
          markdown: "Which?",
          options: ["Pro", "x".repeat(61)],
        },
      },
    });
    expect(failure(long)).toBe(
      "invalid input for widget_respond: options.1: an option is at most 60 characters — shorten it and call again",
    );
  });

  it("tools/call: unknown tool returns a JSON-RPC error", async () => {
    const response = await handler()({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "does_not_exist", arguments: {} },
    });
    expect(response?.error?.code).toBe(-32602);
    expect(response?.error?.message).toMatch(/unknown tool/);
  });

  it("tools/call: invalid input fails the call with the validation message (SEP-1303)", async () => {
    const response = await handler()({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "workspace_read_document", arguments: { path: 123 } },
    });
    expect(failure(response)).toMatch(
      /^invalid input for workspace_read_document: path: /,
    );
  });

  it("tools/call: repairs a nested argument delivered as a JSON string (OpenCode quirk)", async () => {
    // OpenCode has been observed sending `payload` as the JSON *string* of
    // the object (v2-opencode-config-mcp-spike.md); one repair pass re-parses
    // it before rejecting.
    const response = await handler(undefined, withNestedTool)({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "nested_echo",
        arguments: { payload: '{"prompt": "Pick one"}' },
      },
    });
    expect(response?.error).toBeUndefined();
    const result = response?.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBeUndefined();
    // The tool got the parsed payload, not the string.
    expect(JSON.parse(result.content[0].text)).toEqual({ prompt: "Pick one" });
  });

  it("tools/call: happy path dispatches to the tool and wraps the result as MCP content", async () => {
    const response = await handler()({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "workspace_open_files", arguments: {} },
    });
    const result = response?.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0].type).toBe("text");
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
  });

  it("tools/call: a requiresPermission tool blocks on the broker and returns isError on deny", async () => {
    const broker = new PermissionBroker(ctx.taskId, store.permissionRequests);
    const pending = handler(broker)({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "history_restore",
        arguments: { path: "notes.md", checkpoint: "abc123" },
      },
    });

    const row = store.permissionRequests.toArray.find(
      (r) => r.taskId === ctx.taskId && r.status === "pending",
    );
    expect(row).toBeDefined();
    broker.respond(row!.id, {
      outcome: { outcome: "selected", optionId: "deny" },
    });

    const response = await pending;
    const result = response?.result as {
      isError: true;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/permission denied/);
  });

  it("unknown method returns a JSON-RPC method-not-found error", async () => {
    const response = await handler()({
      jsonrpc: "2.0",
      id: 7,
      method: "not/a/real/method",
    });
    expect(response?.error?.code).toBe(-32601);
  });

  it("tools/call: a tool that returns ok:false becomes an isError MCP result", async () => {
    readWorkspaceTextFile.mockRejectedValueOnce(new Error("disk detached"));
    const response = await handler()({
      jsonrpc: "2.0",
      id: 50,
      method: "tools/call",
      params: { name: "workspace_read_document", arguments: { path: "a.md" } },
    });
    const result = response?.result as {
      isError: true;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("disk detached");
  });

  it("tools/call: missing name and missing arguments are handled", async () => {
    const noName = await handler()({
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
    });
    expect(noName?.error?.code).toBe(-32602);
    expect(noName?.error?.message).toContain("(missing name)");

    // Omitted arguments default to {} — fine for a no-input tool.
    const noArgs = await handler()({
      jsonrpc: "2.0",
      id: 52,
      method: "tools/call",
      params: { name: "workspace_open_files" },
    });
    expect(noArgs?.error).toBeUndefined();
  });

  it("tools/call: the repair pass leaves non-object arguments and broken JSON strings alone", async () => {
    // Arguments that aren't a plain object can't be repaired.
    const arrayArgs = await handler()({
      jsonrpc: "2.0",
      id: 53,
      method: "tools/call",
      params: { name: "widget_respond", arguments: ["kind", "answer"] },
    });
    expect(failure(arrayArgs)).toContain("invalid input for widget_respond");

    // A value that looks like JSON but doesn't parse keeps the original
    // string and still fails validation.
    const brokenJson = await handler(undefined, withNestedTool)({
      jsonrpc: "2.0",
      id: 54,
      method: "tools/call",
      params: {
        name: "nested_echo",
        arguments: { payload: '{"prompt": broken' },
      },
    });
    expect(failure(brokenJson)).toMatch(/invalid input for nested_echo/);
  });

  it("resources/list is empty (widget-context URIs are handed out inline, not enumerated)", async () => {
    const response = await handler()({
      jsonrpc: "2.0",
      id: 55,
      method: "resources/list",
      params: {},
    });
    expect(response?.result).toEqual({ resources: [] });
  });

  it("resources/read: a missing uri returns a JSON-RPC error without decoding", async () => {
    const response = await handler()({
      jsonrpc: "2.0",
      id: 56,
      method: "resources/read",
    });
    expect(response?.error?.code).toBe(-32602);
    expect(response?.error?.message).toContain("(missing)");
    expect(buildWidgetContextPayload).not.toHaveBeenCalled();
  });
});

describe("attachMcpEndpoint", () => {
  function fakeEndpoint() {
    let onRequest:
      | ((line: string, respond: (response: string) => void) => void)
      | undefined;
    const endpoint: McpEndpoint = {
      start: async () => {},
      onRequest(cb) {
        onRequest = cb;
        return () => {
          onRequest = undefined;
        };
      },
      close: async () => {},
    };
    return {
      endpoint,
      send: (line: string) =>
        new Promise<string | null>((resolve) => {
          let responded = false;
          onRequest!(line, (response) => {
            responded = true;
            resolve(response);
          });
          // Give the async handler a beat; notifications never respond.
          setTimeout(() => {
            if (!responded) resolve(null);
          }, 10);
        }),
    };
  }

  it("answers unparseable lines with a JSON-RPC parse error", async () => {
    const { endpoint, send } = fakeEndpoint();
    attachMcpEndpoint(endpoint, handler());
    const raw = await send("this is not json");
    const parsed = JSON.parse(raw!) as {
      id: null;
      error: { code: number; message: string };
    };
    expect(parsed.id).toBeNull();
    expect(parsed.error.code).toBe(-32700);
  });

  it("stays silent for notifications (handler returns null)", async () => {
    const { endpoint, send } = fakeEndpoint();
    attachMcpEndpoint(endpoint, handler());
    const raw = await send(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(raw).toBeNull();
  });
});
