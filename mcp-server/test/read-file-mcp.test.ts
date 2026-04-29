import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MAX_EDIT_FILE_BYTES } from "../src/filesystem/edit-file-limits.js";
import { createMcpServer } from "../src/server.js";

describe("read_file MCP tool", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-read-file-mcp-"));
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "file.ts"), "alpha\nbeta\ngamma\n");
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("is registered and callable through MCP", async () => {
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("read_file");

      const result = await client.callTool({
        name: "read_file",
        arguments: {
          paths: ["src/file.ts"],
          startLine: 2,
          endLine: 2,
        },
      });

      expect(result.isError).toBeUndefined();
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]).toMatchObject({
        type: "text",
      });
      expect(content[0]?.text).toMatch(/\[File Hash: [0-9a-f]{8}\]\n2: A[0-9a-f]{8}§beta/u);
      expect(result.structuredContent).toMatchObject({
        lineLimit: 2_000,
        truncated: false,
        files: [
          {
            path: path.join(workspaceRoot, "src", "file.ts"),
            relativePath: "src/file.ts",
            editFileCompatibility: {
              editable: true,
              maxBytes: MAX_EDIT_FILE_BYTES,
            },
            totalLines: 3,
            startLine: 2,
            endLine: 2,
            truncated: false,
          },
        ],
      });
      const structured = result.structuredContent as {
        files: Array<{
          lines: Array<{ line: number; text: string; anchor: string; formatted: string }>;
        }>;
      };
      expect(structured.files[0].lines).toHaveLength(1);
      expect(structured.files[0].lines[0]).toMatchObject({
        line: 2,
        text: "beta",
      });
      expect(structured.files[0].lines[0].anchor).toMatch(/^A[0-9a-f]{8}$/u);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns an MCP-friendly missing path error", async () => {
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const result = await client.callTool({
        name: "read_file",
        arguments: {
          paths: ["missing.ts"],
        },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: "Path 'missing.ts' does not exist.",
        },
      ]);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns edit_file compatibility metadata and text warning for files over the edit cap", async () => {
    await fs.writeFile(path.join(workspaceRoot, "src", "large.ts"), `first\n${"x".repeat(MAX_EDIT_FILE_BYTES)}\n`);
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const result = await client.callTool({
        name: "read_file",
        arguments: {
          paths: ["src/large.ts"],
          startLine: 1,
          endLine: 1,
        },
      });

      expect(result.isError).toBeUndefined();
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain(
        "[Edit File Warning: This file exceeds the 1MB edit mutation cap. read_file can inspect it with line ranges, but edit_file cannot mutate it.]",
      );
      expect(result.structuredContent).toMatchObject({
        files: [
          {
            relativePath: "src/large.ts",
            editFileCompatibility: {
              editable: false,
              maxBytes: MAX_EDIT_FILE_BYTES,
              reason:
                "This file exceeds the 1MB edit mutation cap. read_file can inspect it with line ranges, but edit_file cannot mutate it.",
            },
          },
        ],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns an MCP-friendly out-of-workspace error", async () => {
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const result = await client.callTool({
        name: "read_file",
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
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns an MCP-friendly directory path error", async () => {
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const result = await client.callTool({
        name: "read_file",
        arguments: {
          paths: ["src"],
        },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toBe("Path 'src' is a directory, not a file.");
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
