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
      matchType: "exact",
      signature: "export function buildName(value: string): string",
      location: { startLine: 1, endLine: 3 },
      sourceStartLine: 1,
      sourceEndLine: 3,
    });

    const compact = formatGetFunctionCompact(result);
    expect(compact).toContain("src/sample.ts::buildName | function | L1-3");
    expect(compact).toContain("1|export function buildName(value: string): string {");
    expect(compact).not.toContain("startByte");
    expect(compact).not.toContain("parse:ok");
    expect(compact).not.toContain("body:");
    expect(JSON.stringify(compactGetFunctionResult(result))).not.toContain("sourceStartLine");
  });

  it("extracts qualified class methods and includes explicit edit anchors only for edit mode", async () => {
    const result = await getWorkspaceFunctions(
      context,
      {
        paths: ["src/sample.ts"],
        function_names: ["Greeter.getName"],
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
    expect(match.edit?.content).toMatch(/A[0-9a-z]{6}. {2}getName\(\): string \{/u);
    expect(formatGetFunctionCompact(result, { view: "edit" })).toContain("body:");
  });

  it("returns all ambiguous suffix matches by default and supports strict requireUnique", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "ambiguous.ts"),
      ["class First { save() { return 1; } }", "class Second { save() { return 2; } }", ""].join("\n"),
    );

    const result = await getWorkspaceFunctions(context, { paths: ["src/ambiguous.ts"], function_names: ["save"] });

    expect(result.matchCount).toBe(2);
    expect(result.ambiguous).toEqual([
      {
        relativePath: "src/ambiguous.ts",
        requestedName: "save",
        candidates: ["First.save", "Second.save"],
      },
    ]);
    expect(result.files[0].matches.map((match) => [match.qualifiedName, match.matchType])).toEqual([
      ["First.save", "suffix"],
      ["Second.save", "suffix"],
    ]);

    await expect(
      getWorkspaceFunctions(context, { paths: ["src/ambiguous.ts"], function_names: ["save"], requireUnique: true }),
    ).rejects.toThrow("Function name 'save' is ambiguous in src/ambiguous.ts");
  });

  it("returns explicit missing metadata for partial and complete misses", async () => {
    const partial = await getWorkspaceFunctions(context, {
      paths: ["src/sample.ts"],
      function_names: ["buildName", "missing"],
    });

    expect(partial.missing).toEqual([{ relativePath: "src/sample.ts", functionName: "missing" }]);
    expect(formatGetFunctionCompact(partial)).toContain("src/sample.ts::missing missing");

    const missing = await getWorkspaceFunctions(context, { paths: ["src/sample.ts"], function_names: ["missing"] });
    expect(missing).toMatchObject({
      matchCount: 0,
      missing: [{ relativePath: "src/sample.ts", functionName: "missing" }],
    });
  });

  it("truncates long function source by line and character budgets", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "long.ts"),
      ["export function long() {", ...Array.from({ length: 20 }, (_, index) => `  const value${index} = '${"x".repeat(20)}';`), "}"].join("\n"),
    );

    const result = await getWorkspaceFunctions(context, {
      paths: ["src/long.ts"],
      function_names: ["long"],
      sourceLineLimit: 3,
      maxSourceChars: 80,
    });

    expect(result.truncated).toBe(true);
    expect(result.files[0].matches[0].source).toContain("[get_function source truncated]");
    expect(result.files[0].matches[0].truncatedBy).toBe("lines+chars");
  });

  it("keeps default context at zero and hashes exact body separately from returned view", async () => {
    const result = await getWorkspaceFunctions(context, {
      paths: ["src/sample.ts"],
      function_names: ["Greeter.getName"],
    });
    const withContext = await getWorkspaceFunctions(context, {
      paths: ["src/sample.ts"],
      function_names: ["Greeter.getName"],
      contextLines: 1,
    });

    expect(result.contextLines).toBe(0);
    expect(result.files[0].matches[0]).toMatchObject({
      sourceStartLine: 5,
      sourceEndLine: 7,
      contextLinesBefore: 0,
      contextLinesAfter: 0,
    });
    expect(withContext.files[0].matches[0].bodyHash).toBe(result.files[0].matches[0].bodyHash);
    expect(withContext.files[0].matches[0].viewHash).not.toBe(result.files[0].matches[0].viewHash);
  });

  it("handles CRLF, BOM, unicode names, and no trailing newline", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "unicode.ts"),
      "\uFEFFexport function café(value: string) {\r\n  return value.trim();\r\n}",
    );

    const result = await getWorkspaceFunctions(context, {
      paths: ["src/unicode.ts"],
      function_names: ["café"],
    });

    expect(result.matchCount).toBe(1);
    expect(result.files[0].matches[0]).toMatchObject({
      qualifiedName: "café",
      sourceStartLine: 1,
      sourceEndLine: 3,
    });
  });

  it("collapses TypeScript overload signatures to the implementation", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "overloads.ts"),
      [
        "export function parse(value: string): string;",
        "export function parse(value: number): string;",
        "export function parse(value: string | number): string {",
        "  return String(value);",
        "}",
        "",
      ].join("\n"),
    );

    const result = await getWorkspaceFunctions(context, {
      paths: ["src/overloads.ts"],
      function_names: ["parse"],
    });

    expect(result.matchCount).toBe(1);
    expect(result.files[0].matches[0].source).toContain("3|export function parse(value: string | number): string {");
  });

  it("surfaces file safety errors from the AST loader and get_function revalidation", async () => {
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# readme\n");

    await expect(getWorkspaceFunctions(context, { paths: ["README.md"], function_names: ["anything"] })).rejects.toThrow(
      "Unsupported get_file_skeleton file extension '.md'",
    );
    await expect(getWorkspaceFunctions(context, { paths: [".."], function_names: ["anything"] })).rejects.toThrow(
      "outside the configured workspace roots",
    );
  });

  it("caps overly broad path/function lookup requests", async () => {
    await expect(
      getWorkspaceFunctions(context, {
        paths: ["src/sample.ts", "src/sample.ts"],
        function_names: Array.from({ length: 101 }, (_, index) => `fn${index}`),
      }),
    ).rejects.toThrow("path/function lookups exceeds the limit");
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
      function_names: [functionName],
      contextLines: 0,
    });
    const compact = formatGetFunctionCompact(result);
    const fullJson = JSON.stringify(result, null, 2);

    expect(result.matchCount).toBe(1);
    expect(result.files[0].matches[0].signature).toContain(expected);
    expect(compact.length).toBeLessThan(fullJson.length * 0.8);
  });
});
