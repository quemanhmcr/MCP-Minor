import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMcpServer } from "../src/server.js";

describe("get_function MCP tool", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-get-function-mcp-"));
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

  it("is registered and callable through MCP with compact source output", async () => {
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("get_function");

      const result = await client.callTool({
        name: "get_function",
        arguments: {
          paths: ["src/file.ts"],
          function_names: ["Worker.run"],
        },
      });

      expect(result.isError).toBeUndefined();
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]).toMatchObject({ type: "text" });
      expect(content[0]?.text).toContain("src/file.ts::Worker.run | method | L2-4 | sig:run()");
      expect(content[0]?.text).toContain("2|  run() {");
      expect(content[0]?.text).not.toContain("startByte");
      expect(content[0]?.text).not.toContain("§");
      expect(result.structuredContent).toMatchObject({
        view: "source",
        matchCount: 1,
        missingCount: 0,
        truncated: false,
        files: [
          {
            relativePath: "src/file.ts",
            language: "typescript",
            hasParseErrors: false,
            matchCount: 1,
            missing: [],
          },
        ],
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain(path.join(workspaceRoot, "src", "file.ts"));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns full structured JSON when requested", async () => {
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const result = await client.callTool({
        name: "get_function",
        arguments: {
          paths: ["src/file.ts"],
          functionNames: ["makeWorker"],
          format: "json",
        },
      });

      const structured = result.structuredContent as {
        files: Array<{ path: string; matches: Array<{ qualifiedName: string; location: { startByte: number } }> }>;
      };
      expect(structured.files[0].path).toBe(path.join(workspaceRoot, "src", "file.ts"));
      expect(structured.files[0].matches[0].qualifiedName).toBe("makeWorker");
      expect(structured.files[0].matches[0].location.startByte).toBeGreaterThan(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns edit-ready anchors only in edit view", async () => {
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const result = await client.callTool({
        name: "get_function",
        arguments: {
          paths: ["src/file.ts"],
          functionNames: ["Worker.run"],
          view: "edit",
        },
      });

      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toMatch(/A[0-9a-z]{6}§ {2}run\(\) \{/u);
      expect(result.structuredContent).toMatchObject({ view: "edit" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns MCP-friendly not-found and ambiguous errors", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "dupe.ts"),
      ["function save() {}", "class Store {", "  save() {}", "}", ""].join("\n"),
    );
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const missing = await client.callTool({
        name: "get_function",
        arguments: {
          paths: ["src/file.ts"],
          functionNames: ["missing"],
        },
      });
      expect(missing.isError).toBe(true);
      expect(missing.content).toEqual([
        {
          type: "text",
          text: "None of the requested functions (missing) were found in src/file.ts.",
        },
      ]);

      const ambiguous = await client.callTool({
        name: "get_function",
        arguments: {
          paths: ["src/dupe.ts"],
          functionNames: ["save"],
        },
      });
      expect(ambiguous.isError).toBe(true);
      expect((ambiguous.content as Array<{ text: string }>)[0].text).toContain("Function name 'save' is ambiguous");
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
