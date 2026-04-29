import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMcpServer } from "../src/server.js";

describe("list_files MCP tool", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-list-files-mcp-"));
    await fs.writeFile(path.join(workspaceRoot, "file.txt"), "content");
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("is registered and callable through MCP", async () => {
    const server = createMcpServer({
      cwd: workspaceRoot,
      sessionId: "test",
      workspaceRoots: [workspaceRoot],
    });
    const client = new Client({
      name: "test-client",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("list_files");

      const result = await client.callTool({
        name: "list_files",
        arguments: {
          paths: ["."],
        },
      });

      expect(result.structuredContent).toEqual({
        entries: [
          {
            path: path.join(workspaceRoot, "file.txt"),
            type: "file",
            relativePath: "file.txt",
          },
        ],
        limit: 200,
        truncated: false,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns an MCP-friendly error for out-of-workspace paths", async () => {
    const server = createMcpServer({
      cwd: workspaceRoot,
      sessionId: "test",
      workspaceRoots: [workspaceRoot],
    });
    const client = new Client({
      name: "test-client",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const result = await client.callTool({
        name: "list_files",
        arguments: {
          paths: [".."],
        },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: "Path '..' resolves outside the configured workspace roots.",
        },
      ]);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("clamps oversized limits through MCP", async () => {
    const server = createMcpServer({
      cwd: workspaceRoot,
      sessionId: "test",
      workspaceRoots: [workspaceRoot],
    });
    const client = new Client({
      name: "test-client",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const result = await client.callTool({
        name: "list_files",
        arguments: {
          paths: ["."],
          limit: 10_000,
        },
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        limit: 1_000,
        truncated: false,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
