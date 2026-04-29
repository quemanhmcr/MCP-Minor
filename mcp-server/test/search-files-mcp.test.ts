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
});
