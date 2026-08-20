import { describe, expect, it, vi } from "vitest";
import {
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  negotiateMcpProtocolVersion,
  createMcpRequestHandler,
  type McpHandlerDeps,
} from "../mcp-server";

const LATEST = SUPPORTED_MCP_PROTOCOL_VERSIONS[0];

function stubDeps(): McpHandlerDeps {
  return {
    ctx: {
      workspacePath: "/ws",
      taskId: "task_ver",
      agents: {
        task: () => ({
          prompt: () => undefined,
          cancel: async () => undefined,
        }),
        workspace: () => ({ createTask: async () => undefined }),
      },
    },
    permissionBroker: {
      request: async () => ({
        outcome: { outcome: "selected", optionId: "allow" },
      }),
    },
    tools: { list: () => [], get: () => undefined },
    translate: (key) => key,
    instructions: () => "test instructions",
    buildWidgetContextPayload: async () => ({}),
  };
}

describe("negotiateMcpProtocolVersion", () => {
  it("echoes every supported revision", () => {
    for (const version of SUPPORTED_MCP_PROTOCOL_VERSIONS) {
      expect(negotiateMcpProtocolVersion(version)).toBe(version);
    }
  });

  it("offers our latest for an unknown future revision (MET-153: no verbatim echo)", () => {
    expect(negotiateMcpProtocolVersion("2099-01-01")).toBe(LATEST);
  });

  it("offers our latest when the client sends no version", () => {
    expect(negotiateMcpProtocolVersion(undefined)).toBe(LATEST);
  });
});

describe("initialize negotiation through the request handler", () => {
  it("echoes a supported requested version", async () => {
    const response = await createMcpRequestHandler(stubDeps())({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    expect(response?.result).toMatchObject({ protocolVersion: "2024-11-05" });
  });

  it("counter-offers our latest for an unsupported version", async () => {
    const response = await createMcpRequestHandler(stubDeps())({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2099-01-01" },
    });
    expect(response?.result).toMatchObject({ protocolVersion: LATEST });
  });

  it("reports an unsupported requested version to the observability hook", async () => {
    const onUnsupportedProtocolVersion = vi.fn();
    const handler = createMcpRequestHandler({
      ...stubDeps(),
      onUnsupportedProtocolVersion,
    });

    // A supported echo is not worth reporting.
    await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(onUnsupportedProtocolVersion).not.toHaveBeenCalled();

    await handler({
      jsonrpc: "2.0",
      id: 4,
      method: "initialize",
      params: { protocolVersion: "2099-01-01" },
    });
    expect(onUnsupportedProtocolVersion).toHaveBeenCalledWith("2099-01-01");

    // A client that sent no version at all is reported as undefined.
    await handler({ jsonrpc: "2.0", id: 5, method: "initialize", params: {} });
    expect(onUnsupportedProtocolVersion).toHaveBeenCalledWith(undefined);
  });
});
