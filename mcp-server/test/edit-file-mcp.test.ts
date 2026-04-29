import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMcpServer } from "../src/server.js";
import { resetAnchorState } from "../src/runtime/anchor-state.js";

describe("edit_file MCP tool", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-edit-file-mcp-"));
    resetAnchorState();
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "file.ts"), "alpha\nbeta\ngamma\n");
  });

  afterEach(async () => {
    resetAnchorState();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("is registered", async () => {
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("edit_file");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("supports read_file -> edit_file -> read_file through InMemoryTransport", async () => {
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const betaAnchor = await readAnchor(client, "beta");
      const editResult = await client.callTool({
        name: "edit_file",
        arguments: {
          path: "src/file.ts",
          edits: [{ anchor: betaAnchor, oldText: "beta", newText: "BETA" }],
        },
      });

      expect(editResult.isError).toBeUndefined();
      expect(editResult.structuredContent).toMatchObject({
        relativePath: "src/file.ts",
        changed: true,
        editsApplied: 1,
        lineEnding: "lf",
        appliedEdits: [
          {
            anchor: betaAnchor,
            startLine: 2,
            endLine: 2,
            oldText: "beta",
            newText: "BETA",
          },
        ],
      });

      const reread = await client.callTool({
        name: "read_file",
        arguments: { paths: ["src/file.ts"] },
      });
      const structured = reread.structuredContent as {
        files: Array<{ lines: Array<{ text: string }> }>;
      };
      expect(structured.files[0].lines.map((line) => line.text)).toEqual(["alpha", "BETA", "gamma"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns MCP-friendly stale or mismatch errors", async () => {
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const betaAnchor = await readAnchor(client, "beta");
      const result = await client.callTool({
        name: "edit_file",
        arguments: {
          path: "src/file.ts",
          edits: [{ anchor: betaAnchor, oldText: "wrong", newText: "BETA" }],
        },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain("oldText mismatch");
      expect(content[0].text).not.toContain("\n    at ");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns MCP-friendly out-of-workspace errors", async () => {
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const result = await client.callTool({
        name: "edit_file",
        arguments: {
          path: "..",
          edits: [{ anchor: "A00000000", oldText: "x", newText: "y" }],
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

  it("keeps structuredContent shape stable", async () => {
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const betaAnchor = await readAnchor(client, "beta");
      const result = await client.callTool({
        name: "edit_file",
        arguments: {
          path: "src/file.ts",
          edits: [{ anchor: betaAnchor, oldText: "beta", newText: "BETA\nBETA2" }],
        },
      });

      expect(Object.keys(result.structuredContent as Record<string, unknown>)).toEqual([
        "path",
        "relativePath",
        "changed",
        "editsApplied",
        "fileHashBefore",
        "fileHashAfter",
        "lineEnding",
        "appliedEdits",
        "diff",
      ]);
      expect((result.structuredContent as { diff: string }).diff).toBe(
        ["*** Update File: src/file.ts", "@@ 2,1 -> 2 @@", "-beta", "+BETA", "+BETA2"].join("\n"),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});

async function readAnchor(client: Client, text: string): Promise<string> {
  const result = await client.callTool({
    name: "read_file",
    arguments: { paths: ["src/file.ts"] },
  });
  const structured = result.structuredContent as {
    files: Array<{ lines: Array<{ text: string; anchor: string }> }>;
  };
  const line = structured.files[0].lines.find((candidate) => candidate.text === text);
  if (!line) {
    throw new Error(`Anchor for '${text}' not found.`);
  }

  return line.anchor;
}

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
