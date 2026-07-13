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
const { writeWorkspaceTextFile } = vi.hoisted(() => ({
  writeWorkspaceTextFile: vi.fn(async () => {}),
}));
vi.mock("@/utils/file-sync", () => ({
  readWorkspaceTextFile: vi.fn(async () => "# Doc\n"),
  writeWorkspaceTextFile,
}));

import { createMcpRequestHandler } from "../mcp-server";
import { PermissionBroker } from "../permission-broker";
import { agentPermissionRequestsCollection } from "../agent-collections";
import type { ToolContext } from "@metrists/shared/agent";

// vi.hoisted can't reference `z` (hoisted above the "zod" import); assign
// real schemas onto the mocked blob types now that imports have resolved.
blobTypes[0].schema = z.object({ prompt: z.string(), options: z.array(z.string()).optional() });
blobTypes[1].schema = z.object({ prompt: z.string() });
blobTypes[2].schema = z.object({ label: z.string(), state: z.enum(["pending", "done"]) });

const ctx: ToolContext = {
  workspacePath: "/ws",
  taskId: "task_mcp_1",
  agents: {
    task: () => ({ prompt: vi.fn(), cancel: vi.fn() }),
    workspace: () => ({ createTask: vi.fn() }),
  },
};

function handler(permissionBroker = new PermissionBroker(ctx.taskId)) {
  return createMcpRequestHandler({ ctx, permissionBroker });
}

describe("createMcpRequestHandler", () => {
  beforeEach(() => {
    for (const r of agentPermissionRequestsCollection.toArray) {
      agentPermissionRequestsCollection.delete(r.id);
    }
  });

  it("initialize returns capabilities and server info", async () => {
    const response = await handler()({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "metrists", version: "1.0.0" },
      },
    });
  });

  it("notifications/initialized returns null (no response)", async () => {
    const response = await handler()({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response).toBeNull();
  });

  it("tools/list includes every registered tool with a title, a JSON Schema, and author_blob's payload is an anyOf over registered blob types", async () => {
    const response = await handler()({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
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
    expect(response?.error?.message).toMatch(/invalid input for workspace_read_document/);
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
    const result = response?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ blobId: "question_str1" });
    // The written fence carries the parsed payload, not the string.
    const written = writeWorkspaceTextFile.mock.calls.at(-1) as unknown as [string, string];
    expect(written[1]).toContain("Pick one");
  });

  it("tools/call: happy path dispatches to the tool and wraps the result as MCP content", async () => {
    const response = await handler()({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "workspace_open_files", arguments: {} },
    });
    const result = response?.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].type).toBe("text");
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
  });

  it("tools/call: a requiresPermission tool blocks on the broker and returns isError on deny", async () => {
    const broker = new PermissionBroker(ctx.taskId);
    const pending = handler(broker)({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "history_restore", arguments: { path: "notes.md", checkpoint: "abc123" } },
    });

    const row = agentPermissionRequestsCollection.toArray.find(
      (r) => r.taskId === ctx.taskId && r.status === "pending",
    );
    expect(row).toBeDefined();
    broker.respond(row!.id, { outcome: { outcome: "selected", optionId: "deny" } });

    const response = await pending;
    const result = response?.result as { isError: true; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/permission denied/);
  });

  it("unknown method returns a JSON-RPC method-not-found error", async () => {
    const response = await handler()({ jsonrpc: "2.0", id: 7, method: "not/a/real/method" });
    expect(response?.error?.code).toBe(-32601);
  });
});
