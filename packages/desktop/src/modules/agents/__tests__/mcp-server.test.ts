import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// The workspace_read_document tests below read through the task's
// documents; fake them so dispatch exercises the real tools without
// touching a real workspace.
const readWorkspaceTextFile = vi.fn(async (_path: string) => "# Doc\n");

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
import type { McpEndpoint, ToolContext } from "@notefig/agent";
import { PermissionBroker } from "../permission-broker";
import type { AgentStore } from "../agent-collections";
import type { AgentTool } from "@notefig/agent";
import { toolRegistry, getTool } from "../tools";
import { serverInstructions } from "../mcp-instructions";
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
    documents: { read: readWorkspaceTextFile },
    // workspace_open_files reads the task's layout.
    layout: createLayout(memoryUrlState()),
  } as unknown as ToolContext["services"],
};

// The broker's permission requests, fresh per test.
let store: AgentStore;

function handler(
  permissionBroker = new PermissionBroker(
    ctx.taskId,
    store.permissionRequests,
  ),
  tools = { list: () => toolRegistry, get: getTool },
) {
  return createMcpRequestHandler({
    ctx,
    permissionBroker,
    // The real desktop registry — this suite is deliberately an integration
    // test of the protocol handler against the actual tool set. The repair
    // tests swap in a registry with one extra nested-object tool, since no
    // real tool takes an object argument anymore.
    tools,
    translate: (key) => i18n.t(key),
    instructions: serverInstructions,
    buildWidgetContextPayload,
  });
}

/** A stand-in for the old author_blob: the one tool shape whose argument
 *  arrives as a JSON *string* from a harness (the OpenCode quirk the repair
 *  pass exists for) — an object-valued field no remaining real tool has. */
function handlerWithNestedTool() {
  const echoNested: AgentTool<{ payload: { prompt: string } }, unknown> = {
    name: "echo_nested",
    title: "agentToolWidgetRespond",
    description: "echoes its object payload",
    input: z.object({ payload: z.object({ prompt: z.string() }) }),
    async execute(_ctx, input) {
      return { ok: true, value: input };
    },
  };
  return handler(undefined, {
    list: () => [echoNested],
    get: (name: string) => (name === "echo_nested" ? echoNested : undefined),
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
    // The old question-block tool is gone (MET-250): its steering is gone
    // with it, and choosing between alternatives happens through
    // widget_respond's options instead.
    expect(instructions).not.toContain("author_blob");
    expect(instructions).toContain("options");
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

  it("tools/list includes every registered tool with a title and a JSON Schema — and no author_blob (MET-250)", async () => {
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
    // The old question-choice tool is off the list entirely.
    expect(names).not.toContain("author_blob");

    const widgetRespond = result.tools.find((t) => t.name === "widget_respond");
    const schema = widgetRespond?.inputSchema as {
      properties: { options?: { type: string } };
    };
    // The choice affordance the old tool used to carry lives on
    // widget_respond now: an optional list of short labels.
    expect(schema.properties.options?.type).toBe("array");
  });

  it("tools/call: widget_respond acknowledges valid input, options included, and rejects a bad kind", async () => {
    const ok = await handler()({
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: {
        name: "widget_respond",
        arguments: {
          kind: "answer",
          markdown: "Two options stand out.",
          options: ["Free", "Pro"],
        },
      },
    });
    const result = ok?.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(JSON.parse(result.content[0].text)).toEqual({ recorded: true });

    // An empty options list is not a list — rejected like a missing field.
    const emptyOptions = await handler()({
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: {
        name: "widget_respond",
        arguments: { kind: "answer", markdown: "x", options: [] },
      },
    });
    expect(emptyOptions?.error?.code).toBe(-32602);

    const bad = await handler()({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: {
        name: "widget_respond",
        arguments: { kind: "summary", markdown: "x" },
      },
    });
    expect(bad?.error?.code).toBe(-32602);
    expect(bad?.error?.message).toContain("widget_respond");
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

  it("tools/call: invalid input returns a JSON-RPC error with the validation message", async () => {
    const response = await handler()({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "workspace_read_document", arguments: { path: 123 } },
    });
    expect(response?.error?.code).toBe(-32602);
    expect(response?.error?.message).toMatch(
      /invalid input for workspace_read_document/,
    );
  });

  it("tools/call: repairs a nested argument delivered as a JSON string (OpenCode quirk)", async () => {
    // OpenCode has been observed sending an object argument as the JSON
    // *string* of that object (v2-opencode-config-mcp-spike.md); one repair
    // pass re-parses it before rejecting. echo_nested is the shape that
    // exercises this — an object-valued field, which no remaining real tool
    // takes.
    const response = await handlerWithNestedTool()({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "echo_nested",
        arguments: {
          payload: '{"prompt": "Pick one"}',
        },
      },
    });
    expect(response?.error).toBeUndefined();
    const result = response?.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      payload: { prompt: "Pick one" },
    });
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
    expect(arrayArgs?.error?.code).toBe(-32602);

    // A value that looks like JSON but doesn't parse keeps the original
    // string and still fails validation.
    const brokenJson = await handlerWithNestedTool()({
      jsonrpc: "2.0",
      id: 54,
      method: "tools/call",
      params: {
        name: "echo_nested",
        arguments: {
          payload: '{"prompt": broken',
        },
      },
    });
    expect(brokenJson?.error?.code).toBe(-32602);
    expect(brokenJson?.error?.message).toMatch(/invalid input for echo_nested/);
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
