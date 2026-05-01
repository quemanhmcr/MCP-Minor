/**
 * Phase 0 acceptance scenarios not already covered in per-tool MCP test files.
 *
 * Covers:
 *  1. All six v1 tools listed via MCP
 *  2. Anchor determinism within a session
 *  3. Agentic chain: list_files → search_files → read_file → get_function → edit_file
 *  4. Binary file rejection through MCP boundary
 *  5. Symlink escape rejection through MCP boundary
 *  6. search_files empty-match result through MCP boundary
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMcpServer } from "../src/server.js";
import { resetAnchorState } from "../src/runtime/anchor-state.js";

describe("Phase 0 acceptance: server initialization", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-phase0-init-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("exposes exactly the six v1 tools via MCP tool listing", async () => {
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "edit_file",
        "get_file_skeleton",
        "get_function",
        "list_files",
        "read_file",
        "search_files",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("Phase 0 acceptance: anchor determinism", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-phase0-anchors-"));
    resetAnchorState();
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "file.ts"), "alpha\nbeta\ngamma\n");
  });

  afterEach(async () => {
    resetAnchorState();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("returns identical anchor ids on two consecutive reads of an unchanged file in the same session", async () => {
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const first = await client.callTool({
        name: "read_file",
        arguments: { paths: ["src/file.ts"], format: "json" },
      });
      const second = await client.callTool({
        name: "read_file",
        arguments: { paths: ["src/file.ts"], format: "json" },
      });

      type StructuredRead = { files: Array<{ lines: Array<{ anchor: string }> }> };
      const s1 = first.structuredContent as StructuredRead;
      const s2 = second.structuredContent as StructuredRead;

      const anchors1 = s1.files[0].lines.map((l) => l.anchor);
      const anchors2 = s2.files[0].lines.map((l) => l.anchor);

      expect(anchors1).toHaveLength(3);
      expect(anchors1).toEqual(anchors2);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("Phase 0 acceptance: agentic chain", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-phase0-chain-"));
    resetAnchorState();
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "src", "utils.ts"),
      [
        "export function greet(name: string): string {",
        '  return `Hello, ${name}!`;',
        "}",
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    resetAnchorState();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("executes list_files → search_files → read_file → get_function → edit_file over the MCP boundary", async () => {
    const { client, server } = await connectClient(workspaceRoot);

    try {
      // Step 1: list_files — discover files in src/
      const listed = await client.callTool({
        name: "list_files",
        arguments: { paths: ["src"] },
      });
      expect(listed.isError).toBeUndefined();
      const listText = (listed.content as Array<{ text: string }>)[0].text;
      expect(listText).toContain("utils.ts");

      // Step 2: search_files — locate the function by pattern
      const searched = await client.callTool({
        name: "search_files",
        arguments: { paths: ["src"], regex: "greet" },
      });
      expect(searched.isError).toBeUndefined();
      const searchText = (searched.content as Array<{ text: string }>)[0].text;
      expect(searchText).toContain("utils.ts");

      // Step 3: read_file — acquire anchors for editing
      const readResult = await client.callTool({
        name: "read_file",
        arguments: { paths: ["src/utils.ts"], format: "json" },
      });
      expect(readResult.isError).toBeUndefined();
      type ReadStructured = { files: Array<{ lines: Array<{ text: string; anchor: string }> }> };
      const readStructured = readResult.structuredContent as ReadStructured;
      const greetLine = readStructured.files[0].lines.find(
        (l) => l.text === "export function greet(name: string): string {",
      );
      expect(greetLine?.anchor).toMatch(/^A[0-9a-z]{6}$/u);

      // Step 4: get_function — inspect the function by name
      const funcResult = await client.callTool({
        name: "get_function",
        arguments: { paths: ["src/utils.ts"], function_names: ["greet"] },
      });
      expect(funcResult.isError).toBeUndefined();
      expect(funcResult.structuredContent).toMatchObject({ matchCount: 1, missingCount: 0 });
      const funcText = (funcResult.content as Array<{ text: string }>)[0].text;
      expect(funcText).toContain("greet");

      // Step 5: edit_file — apply a bounded replacement using the anchor from Step 3
      const editResult = await client.callTool({
        name: "edit_file",
        arguments: {
          path: "src/utils.ts",
          edits: [
            {
              anchor: greetLine!.anchor,
              oldText: "export function greet(name: string): string {",
              newText: "export function greet(name: string): string { // phase0",
            },
          ],
        },
      });
      expect(editResult.isError).toBeUndefined();
      expect(editResult.structuredContent).toMatchObject({ changed: true, editsApplied: 1 });

      // Verify the edit landed
      const verify = await client.callTool({
        name: "read_file",
        arguments: { paths: ["src/utils.ts"], startLine: 1, endLine: 1 },
      });
      const verifyText = (verify.content as Array<{ text: string }>)[0].text;
      expect(verifyText).toContain("// phase0");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("Phase 0 acceptance: binary file rejection through MCP", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-phase0-binary-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("read_file returns an MCP-friendly error for a binary file", async () => {
    await fs.writeFile(path.join(workspaceRoot, "blob.bin"), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const result = await client.callTool({
        name: "read_file",
        arguments: { paths: ["blob.bin"] },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].type).toBe("text");
      expect(content[0].text).toContain("binary");
      expect(content[0].text).not.toContain("\n    at ");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("Phase 0 acceptance: symlink escape rejection through MCP", () => {
  let workspaceRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-phase0-symlink-"));
    outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-phase0-outside-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  });

  it("read_file returns an MCP-friendly error for a symlink pointing outside the workspace", async () => {
    await fs.writeFile(path.join(outsideRoot, "secret.txt"), "secret");

    try {
      await fs.symlink(path.join(outsideRoot, "secret.txt"), path.join(workspaceRoot, "link.txt"));
    } catch (error) {
      if (isSymlinkPermissionError(error)) {
        // Skip on Windows environments without symlink privileges
        return;
      }
      throw error;
    }

    const { client, server } = await connectClient(workspaceRoot);

    try {
      const result = await client.callTool({
        name: "read_file",
        arguments: { paths: ["link.txt"] },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].type).toBe("text");
      expect(content[0].text).toMatch(/symbolic link|symlink/iu);
      expect(content[0].text).not.toContain("\n    at ");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("Phase 0 acceptance: search_files empty results through MCP", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-phase0-empty-search-"));
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "file.ts"), "const x = 1;\n");
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("returns empty match set for a pattern with no matches — not an error", async () => {
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const result = await client.callTool({
        name: "search_files",
        arguments: { paths: ["."], regex: "ZZZNOMATCHZZZ" },
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ matches: 0 });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function isSymlinkPermissionError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES");
}

async function connectClient(workspaceRoot: string) {
  const server = createMcpServer({
    cwd: workspaceRoot,
    sessionId: "test",
    workspaceRoots: [workspaceRoot],
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, server };
}
