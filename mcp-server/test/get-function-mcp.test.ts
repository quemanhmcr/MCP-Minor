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
      expect(content[0]?.text).not.toContain("body:");
      expect(result.structuredContent).toMatchObject({
        view: "source",
        matchCount: 1,
        missingCount: 0,
        ambiguousCount: 0,
        truncated: false,
        files: [
          {
            relativePath: "src/file.ts",
            language: "typescript",
            hasParseErrors: false,
            matches: [
              {
                requestedName: "Worker.run",
                qualifiedName: "Worker.run",
                kind: "method",
                matchType: "exact",
                startLine: 2,
                endLine: 4,
              },
            ],
            matchCount: 1,
            missing: [],
            ambiguous: [],
          },
        ],
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain(path.join(workspaceRoot, "src", "file.ts"));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns full structured metadata without duplicated source by default", async () => {
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const result = await client.callTool({
        name: "get_function",
        arguments: {
          paths: ["src/file.ts"],
          function_names: ["makeWorker"],
          format: "json",
        },
      });

      expect(result.isError).toBeUndefined();
      const structured = result.structuredContent as {
        files: Array<{ path: string; matches: Array<{ qualifiedName: string; source?: string; location: { startByte: number } }> }>;
      };
      expect(structured.files[0].path).toBe(path.join(workspaceRoot, "src", "file.ts"));
      expect(structured.files[0].matches[0].qualifiedName).toBe("makeWorker");
      expect(structured.files[0].matches[0].location.startByte).toBeGreaterThan(0);
      expect(structured.files[0].matches[0]).not.toHaveProperty("source");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("can include source in full structured metadata only when explicitly requested", async () => {
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const result = await client.callTool({
        name: "get_function",
        arguments: {
          paths: ["src/file.ts"],
          function_names: ["makeWorker"],
          view: "full",
          includeSourceInStructured: true,
        },
      });

      const structured = result.structuredContent as {
        files: Array<{ matches: Array<{ source?: string }> }>;
      };
      expect(structured.files[0].matches[0].source).toContain("makeWorker");
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
          function_names: ["Worker.run"],
          view: "edit",
        },
      });

      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toMatch(/A[0-9a-z]{6}. {2}run\(\) \{/u);
      expect(content[0]?.text).toContain("body:");
      expect(result.structuredContent).toMatchObject({ view: "edit" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns structured not-found and ambiguous results instead of tool errors", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "dupe.ts"),
      ["class Store { save() {} }", "class Cache { save() {} }", ""].join("\n"),
    );
    const { client, server } = await connectClient(workspaceRoot);

    try {
      const missing = await client.callTool({
        name: "get_function",
        arguments: {
          paths: ["src/file.ts"],
          function_names: ["missing"],
        },
      });
      expect(missing.isError).toBeUndefined();
      expect(missing.structuredContent).toMatchObject({
        matchCount: 0,
        missingCount: 1,
        files: [{ relativePath: "src/file.ts", missing: ["missing"] }],
      });

      const ambiguous = await client.callTool({
        name: "get_function",
        arguments: {
          paths: ["src/dupe.ts"],
          function_names: ["save"],
        },
      });
      expect(ambiguous.isError).toBeUndefined();
      expect(ambiguous.structuredContent).toMatchObject({
        matchCount: 2,
        ambiguousCount: 1,
      });
      const content = ambiguous.content as Array<{ text: string }>;
      expect(content[0].text).toContain("src/dupe.ts::ambiguous save -> Store.save, Cache.save");
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
