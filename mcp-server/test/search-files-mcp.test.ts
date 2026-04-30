import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMcpServer } from "../src/server.js";

describe("search_files MCP tool", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-search-files-mcp-"));
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "file.ts"), "const searchable = true;\n");
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
      expect(tools.tools.map((tool) => tool.name)).toContain("search_files");

      const result = await client.callTool({
        name: "search_files",
        arguments: {
          paths: ["src"],
          regex: "searchable",
          filePattern: "*.ts",
        },
      });

      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toBe("search: 1/100 matches\nsrc/file.ts:1: searchable");
      expect(result.structuredContent).toEqual({
        view: "matches",
        matches: 1,
        files: 1,
        limit: 100,
        truncated: false,
      });
      expect(content[0]?.text).not.toContain(workspaceRoot);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns full structured JSON when requested", async () => {
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
        name: "search_files",
        arguments: {
          paths: ["src"],
          regex: "searchable",
          filePattern: "*.ts",
          format: "json",
        },
      });

      expect(result.structuredContent).toEqual({
        matches: [
          {
            path: path.join(workspaceRoot, "src", "file.ts"),
            relativePath: "src/file.ts",
            line: 1,
            column: 7,
            match: "searchable",
          },
        ],
        limit: 100,
        truncated: false,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("groups compact matches by file when requested", async () => {
    await fs.writeFile(path.join(workspaceRoot, "src", "other.ts"), "searchable\nsearchable\n");
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
        name: "search_files",
        arguments: {
          paths: ["src"],
          regex: "searchable",
          view: "files",
        },
      });

      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain("matches in 2 files");
      expect(content[0]?.text).toContain("src/other.ts: L1, L2 (2)");
      expect(result.structuredContent).toMatchObject({ view: "files", matches: 3, files: 2 });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns an MCP-friendly invalid regex error", async () => {
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
        name: "search_files",
        arguments: {
          paths: ["src"],
          regex: "[",
        },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.type).toBe("text");
      expect(content[0]?.text).toMatch(/regex|parse/i);
      expect(content[0]?.text).not.toMatch(/at .*searchWorkspaceFiles/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns an MCP-friendly out-of-workspace error", async () => {
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
        name: "search_files",
        arguments: {
          paths: [".."],
          regex: "searchable",
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
});
