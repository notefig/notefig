import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// Real history-service.ts touches isomorphic-git; keep this handler-level
// test focused on MCP request/response shape, not git plumbing (same
// rationale as agent-service.test.ts).
vi.mock("@/utils/history-service", () => ({
  ensureWorkspaceHistoryInitialized: vi.fn(),
  historyGitDir: vi.fn(() => "/ws/.metrists/history"),
  checkpointWorkspaceHistory: vi.fn().mockResolvedValue(null),
}));

// Real blob-registry.ts glob-imports the *.blob.tsx files, which pull in
// blob-node-view -> blob-actions -> agent-service -> tools/index ->
// author-blob -> blob-registry: a circular import that only resolves
// cleanly when entered via agent-service.ts (as agent-service.test.ts does),
// not via blob-registry.ts directly (as this file would). Mock it with real
// Zod schemas (unlike author-blob.test.ts's hand-rolled safeParse stub) so
// zodToJsonSchema still has something real to render.
const { blobTypes } = vi.hoisted(() => ({
  blobTypes: [
    { type: "question", schema: undefined as unknown },
    { type: "approval", schema: undefined as unknown },
    { type: "status", schema: undefined as unknown },
  ],
}));
vi.mock("@/components/editor/blobs/blob-registry", () => ({
  getAllBlobTypes: () => blobTypes,
  getBlobType: (type: string) => blobTypes.find((t) => t.type === type),
}));

// author_blob's execute reads/writes through the file-sync helpers; stub
// them so the stringified-payload repair test below exercises the full
// dispatch without touching a real workspace.
const { readWorkspaceTextFile, writeWorkspaceTextFile } = vi.hoisted(() => ({
  readWorkspaceTextFile: vi.fn(async () => "# Doc\n"),
  writeWorkspaceTextFile: vi.fn(async () => {}),
}));
vi.mock("@/utils/file-sync", () => ({
  readWorkspaceTextFile,
  writeWorkspaceTextFile,
}));

// The payload builder is an injected dep of the handler now (it reads live
// editor state, so the real one stays out of this suite); URI decoding is
// the package's own pure codec and runs for real.
const buildWidgetContextPayload = vi.fn();

import {
  attachMcpEndpoint,
  createMcpRequestHandler,
  encodeWidgetContextUri,
} from "@notefig/agent";
import type { McpEndpoint, ToolContext } from "@notefig/agent";
import { PermissionBroker } from "../permission-broker";
import { agentPermissionRequestsCollection } from "../agent-collections";
import { toolRegistry, getTool } from "../tools";
import { serverInstructions } from "../mcp-instructions";
import i18n from "@/utils/intl";

// vi.hoisted can't reference `z` (hoisted above the "zod" import); assign
// real schemas onto the mocked blob types now that imports have resolved.
blobTypes[0].schema = z.object({
  prompt: z.string(),
  options: z.array(z.string()).optional(),
});
blobTypes[1].schema = z.object({ prompt: z.string() });
blobTypes[2].schema = z.object({
  label: z.string(),
  state: z.enum(["pending", "done"]),
});

const ctx: ToolContext = {
  workspacePath: "/ws",
  taskId: "task_mcp_1",
  agents: {
    task: () => ({ prompt: vi.fn(), cancel: vi.fn() }),
    workspace: () => ({ createTask: vi.fn() }),
  },
};

function handler(permissionBroker = new PermissionBroker(ctx.taskId)) {
  return createMcpRequestHandler({
    ctx,
    permissionBroker,
    // The real desktop registry — this suite is deliberately an integration
    // test of the protocol handler against the actual tool set.
    tools: { list: () => toolRegistry, get: getTool },
    translate: (key) => i18n.t(key),
    instructions: serverInstructions,
    buildWidgetContextPayload,
  });
}

describe("createMcpRequestHandler", () => {
  beforeEach(() => {
    for (const r of agentPermissionRequestsCollection.toArray) {
      agentPermissionRequestsCollection.delete(r.id);
    }
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
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "notefig", version: "1.0.0" },
      },
    });
    const instructions = (response?.result as { instructions?: string })
      .instructions;
    // The steering text lives on the server's own channel (not a prompt
    // preamble) so only sessions that have the server hear about its tools.
    expect(instructions).toContain("author_blob");
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

  it("tools/list includes every registered tool with a title, a JSON Schema, and author_blob's payload is an anyOf over registered blob types", async () => {
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
        "author_blob",
        "widget_respond",
      ]),
    );
    // Every tool has a human-readable title distinct from its snake_case name.
    expect(result.tools.every((t) => t.title && t.title !== t.name)).toBe(true);

    const authorBlob = result.tools.find((t) => t.name === "author_blob");
    expect(authorBlob?.title).toBe("Add Interactive Block");
    const schema = authorBlob?.inputSchema as {
      type: string;
      required: string[];
      properties: { payload: { anyOf: unknown[] }; type: { enum: string[] } };
    };
    expect(schema.required).toEqual(["path", "type", "id"]);
    expect(schema.properties.payload.anyOf.length).toBeGreaterThan(0);
    expect(schema.properties.type.enum).toEqual(
      expect.arrayContaining(["question", "approval", "status"]),
    );
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
    // OpenCode has been observed sending `payload` as the JSON *string* of
    // the object (v2-opencode-config-mcp-spike.md); one repair pass re-parses
    // it before rejecting.
    const response = await handler()({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "author_blob",
        arguments: {
          path: "notes.md",
          type: "question",
          id: "question_str1",
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
      blobId: "question_str1",
    });
    // The written fence carries the parsed payload, not the string.
    const written = writeWorkspaceTextFile.mock.calls.at(-1) as unknown as [
      string,
      string,
    ];
    expect(written[1]).toContain("Pick one");
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
    const broker = new PermissionBroker(ctx.taskId);
    const pending = handler(broker)({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "history_restore",
        arguments: { path: "notes.md", checkpoint: "abc123" },
      },
    });

    const row = agentPermissionRequestsCollection.toArray.find(
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
    const brokenJson = await handler()({
      jsonrpc: "2.0",
      id: 54,
      method: "tools/call",
      params: {
        name: "author_blob",
        arguments: {
          path: "notes.md",
          type: "question",
          id: "question_bad1",
          payload: '{"prompt": broken',
        },
      },
    });
    expect(brokenJson?.error?.code).toBe(-32602);
    expect(brokenJson?.error?.message).toMatch(/invalid input for author_blob/);
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
