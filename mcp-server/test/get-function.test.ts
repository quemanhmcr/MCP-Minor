import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  compactGetFunctionResult,
  formatGetFunctionCompact,
  getWorkspaceFunctions,
} from "../src/filesystem/get-function.js";
import type { RuntimeContext } from "../src/runtime/context.js";

describe("getWorkspaceFunctions", () => {
  let workspaceRoot: string;
  let context: RuntimeContext;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-get-function-"));
    context = {
      cwd: workspaceRoot,
      sessionId: "get-function-test",
      workspaceRoots: [workspaceRoot],
    };
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "src", "sample.ts"),
      [
        "export function buildName(value: string): string {",
        "  return value.trim();",
        "}",
        "export class Greeter {",
        "  getName(): string {",
        "    return buildName('Ada');",
        "  }",
        "  save() {",
        "    return 'method';",
        "  }",
        "}",
        "export function save() {",
        "  return 'top';",
        "}",
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("extracts a targeted top-level function with compact bounded source", async () => {
    const result = await getWorkspaceFunctions(context, {
      paths: ["src/sample.ts"],
      function_names: ["buildName"],
      contextLines: 0,
    });

    expect(result).toMatchObject({
      functionNames: ["buildName"],
      matchCount: 1,
      missing: [],
      truncated: false,
    });
    expect(result.files[0].matches[0]).toMatchObject({
      requestedName: "buildName",
      qualifiedName: "buildName",
      kind: "function",
      signature: "export function buildName(value: string): string",
      location: { startLine: 1, endLine: 3 },
      sourceStartLine: 1,
      sourceEndLine: 3,
    });

    const compact = formatGetFunctionCompact(result);
    expect(compact).toContain("src/sample.ts::buildName | function | L1-3");
    expect(compact).toContain("1|export function buildName(value: string): string {");
    expect(compact).not.toContain("startByte");
    expect(JSON.stringify(compactGetFunctionResult(result))).not.toContain("sourceStartLine");
  });

  it("extracts qualified class methods and includes explicit edit anchors only for edit mode", async () => {
    const result = await getWorkspaceFunctions(
      context,
      {
        paths: ["src/sample.ts"],
        functionNames: ["Greeter.getName"],
        contextLines: 1,
      },
      { includeEditAnchors: true },
    );
    const match = result.files[0].matches[0];

    expect(match).toMatchObject({
      requestedName: "Greeter.getName",
      qualifiedName: "Greeter.getName",
      kind: "method",
      sourceStartLine: 4,
      sourceEndLine: 8,
      contextLinesBefore: 1,
      contextLinesAfter: 1,
    });
    expect(match.edit?.content).toContain("src/sample.ts L4-8/14 edit");
    expect(match.edit?.content).toMatch(/A[0-9a-z]{6}§ {2}getName\(\): string \{/u);
    expect(formatGetFunctionCompact(result, { view: "edit" })).toContain("§");
  });

  it("rejects ambiguous suffix matches", async () => {
    await expect(getWorkspaceFunctions(context, { paths: ["src/sample.ts"], functionNames: ["save"] })).rejects.toThrow(
      "Function name 'save' is ambiguous in src/sample.ts",
    );
  });

  it("returns explicit missing metadata for partial misses and errors when none are found", async () => {
    const partial = await getWorkspaceFunctions(context, {
      paths: ["src/sample.ts"],
      functionNames: ["buildName", "missing"],
    });

    expect(partial.missing).toEqual([{ relativePath: "src/sample.ts", functionName: "missing" }]);
    expect(formatGetFunctionCompact(partial)).toContain("src/sample.ts::missing missing");

    await expect(getWorkspaceFunctions(context, { paths: ["src/sample.ts"], functionNames: ["missing"] })).rejects.toThrow(
      "None of the requested functions (missing) were found",
    );
  });

  it("truncates long function source by line and character budgets", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "long.ts"),
      ["export function long() {", ...Array.from({ length: 20 }, (_, index) => `  const value${index} = '${"x".repeat(20)}';`), "}"].join("\n"),
    );

    const result = await getWorkspaceFunctions(context, {
      paths: ["src/long.ts"],
      functionNames: ["long"],
      contextLines: 0,
      sourceLineLimit: 3,
      maxSourceChars: 80,
    });

    expect(result.truncated).toBe(true);
    expect(result.files[0].matches[0].source).toContain("[get_function source truncated]");
  });

  it("surfaces file safety errors from the AST loader", async () => {
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# readme\n");

    await expect(getWorkspaceFunctions(context, { paths: ["README.md"], functionNames: ["anything"] })).rejects.toThrow(
      "Unsupported get_file_skeleton file extension '.md'",
    );
    await expect(getWorkspaceFunctions(context, { paths: [".."], functionNames: ["anything"] })).rejects.toThrow(
      "outside the configured workspace roots",
    );
  });
});

describe("getWorkspaceFunctions real Dirac repo smoke", () => {
  const repoRoot = path.resolve("..");
  const context: RuntimeContext = {
    cwd: repoRoot,
    sessionId: "get-function-real-repo-smoke",
    workspaceRoots: [repoRoot],
  };

  it.each([
    {
      filePath: "dirac/src/core/task/tools/handlers/GetFunctionToolHandler.ts",
      functionName: "GetFunctionToolHandler.execute",
      expected: "async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse>",
    },
    {
      filePath: "dirac/src/services/tree-sitter/languageParser.ts",
      functionName: "loadRequiredLanguageParsers",
      expected: "loadRequiredLanguageParsers",
    },
  ])("extracts $functionName from pinned Dirac file", async ({ filePath, functionName, expected }) => {
    const result = await getWorkspaceFunctions(context, {
      paths: [filePath],
      functionNames: [functionName],
      contextLines: 0,
    });
    const compact = formatGetFunctionCompact(result);
    const fullJson = JSON.stringify(result, null, 2);

    expect(result.matchCount).toBe(1);
    expect(result.files[0].matches[0].signature).toContain(expected);
    expect(compact.length).toBeLessThan(fullJson.length * 0.8);
  });
});
