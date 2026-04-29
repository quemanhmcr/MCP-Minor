import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMcpServer } from "../src/server.js";

describe("get_file_skeleton MCP tool", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-file-skeleton-mcp-"));
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "src", "file.ts"),
      [
        "export class Worker {",
        "  run() {",
        "    return 1;",
        "  }",
        "}",
        "export const makeWorker = () => new Worker();",
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("is registered and callable through MCP", async () => {
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("get_file_skeleton");

      const result = await client.callTool({
        name: "get_file_skeleton",
        arguments: {
          paths: ["src/file.ts"],
        },
      });

      expect(result.isError).toBeUndefined();
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]).toMatchObject({ type: "text" });
      expect(content[0]?.text).toContain('"name": "Worker"');
      expect(result.structuredContent).toMatchObject({
        limit: 500,
        truncated: false,
        files: [
          {
            path: path.join(workspaceRoot, "src", "file.ts"),
            relativePath: "src/file.ts",
            language: "typescript",
            rootType: "program",
            hasParseErrors: false,
            truncated: false,
          },
        ],
      });

      const structured = result.structuredContent as {
        files: Array<{
          entries: Array<{ kind: string; name: string; children: Array<{ kind: string; name: string }> }>;
        }>;
      };
      expect(structured.files[0].entries.map((entry) => [entry.kind, entry.name])).toEqual([
        ["class", "Worker"],
        ["function", "makeWorker"],
      ]);
      expect(structured.files[0].entries[0].children).toEqual([
        expect.objectContaining({ kind: "method", name: "run" }),
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns an MCP-friendly unsupported extension error", async () => {
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# readme\n");
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const result = await client.callTool({
        name: "get_file_skeleton",
        arguments: {
          paths: ["README.md"],
        },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: "Unsupported get_file_skeleton file extension '.md'. Supported extensions: .cjs, .js, .jsx, .mjs, .ts, .tsx.",
        },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

async function connectClient(workspaceRoot: string) {
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

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, server };
}
