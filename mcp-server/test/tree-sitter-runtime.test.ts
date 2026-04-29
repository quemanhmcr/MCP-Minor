import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getTreeSitterLanguageForPath,
  parseSourceFile,
  resolveTreeSitterAssets,
  TreeSitterRuntimeError,
} from "../src/tree-sitter/runtime.js";

describe("tree-sitter runtime", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac mcp tree sitter "));
    await fs.mkdir(path.join(workspaceRoot, "src folder"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("resolves source-tree query assets and package WASM assets from paths with spaces", () => {
    const descriptor = getTreeSitterLanguageForPath(path.join(workspaceRoot, "src folder", "sample.ts"));
    const assets = resolveTreeSitterAssets(descriptor);

    expect(assets.queryPath.split(path.sep).join("/")).toContain("src/tree-sitter/queries/typescript.scm");
    expect(assets.runtimeWasmPath).toMatch(/tree-sitter\.wasm$/u);
    expect(assets.grammarWasmPath).toMatch(/tree-sitter-typescript\.wasm$/u);
  });

  it("parses TypeScript and exposes useful AST/query output", async () => {
    const filePath = path.join(workspaceRoot, "src folder", "sample.ts");
    await fs.writeFile(
      filePath,
      [
        "interface Named {",
        "  name: string;",
        "}",
        "",
        "export class Greeter implements Named {",
        "  name = 'Ada';",
        "  greet(target: string): string {",
        "    return `${this.name}: ${target}`;",
        "  }",
        "}",
        "",
        "export const makeGreeter = () => new Greeter();",
        "",
      ].join("\n"),
    );

    const result = await parseSourceFile({ filePath });
    const definitionCaptures = result.query
      .captures(result.tree.rootNode)
      .filter((capture) => capture.name.startsWith("name.definition"))
      .map((capture) => capture.node.text);

    expect(result.language.languageId).toBe("typescript");
    expect(result.rootNodeType).toBe("program");
    expect(result.hasError).toBe(false);
    expect(result.sourceLength).toBeGreaterThan(100);
    expect(definitionCaptures).toEqual(expect.arrayContaining(["Named", "Greeter", "greet", "makeGreeter"]));
    result.dispose();
  });

  it("parses JavaScript syntax that exercises the JavaScript grammar", async () => {
    const filePath = path.join(workspaceRoot, "src folder", "sample.js");
    await fs.writeFile(
      filePath,
      [
        "class Counter {",
        "  constructor() {",
        "    this.value = 0;",
        "  }",
        "  increment() {",
        "    this.value += 1;",
        "    return this.value;",
        "  }",
        "}",
        "",
        "export function createCounter() {",
        "  return new Counter();",
        "}",
        "",
      ].join("\n"),
    );

    const result = await parseSourceFile({ filePath });
    const definitionCaptures = result.query
      .captures(result.tree.rootNode)
      .filter((capture) => capture.name.startsWith("name.definition"))
      .map((capture) => capture.node.text);

    expect(result.language.languageId).toBe("javascript");
    expect(result.rootNodeType).toBe("program");
    expect(result.hasError).toBe(false);
    expect(definitionCaptures).toEqual(expect.arrayContaining(["Counter", "increment", "createCounter"]));
    result.dispose();
  });

  it("rejects unsupported file extensions explicitly", async () => {
    await expect(parseSourceFile({ filePath: path.join(workspaceRoot, "README.md"), source: "# Title\n" })).rejects.toThrow(
      "Unsupported tree-sitter file extension '.md'",
    );
  });

  it("reports missing assets explicitly", () => {
    const descriptor = getTreeSitterLanguageForPath("sample.ts");
    const missingAssetRoot = path.join(workspaceRoot, "missing assets");

    expect(() =>
      resolveTreeSitterAssets(descriptor, {
        assetRoots: [missingAssetRoot],
        includeNodeModulesFallback: false,
      }),
    ).toThrow(TreeSitterRuntimeError);
    expect(() =>
      resolveTreeSitterAssets(descriptor, {
        assetRoots: [missingAssetRoot],
        includeNodeModulesFallback: false,
      }),
    ).toThrow("Missing tree-sitter asset");
  });

  it("keeps parser initialization usable after failed asset resolution", async () => {
    const descriptor = getTreeSitterLanguageForPath("sample.ts");

    expect(() =>
      resolveTreeSitterAssets(descriptor, {
        assetRoots: [path.join(workspaceRoot, "missing assets")],
        includeNodeModulesFallback: false,
      }),
    ).toThrow("Missing tree-sitter asset");

    const filePath = path.join(workspaceRoot, "src folder", "after-missing-assets.ts");
    await fs.writeFile(filePath, "export const stillWorks = (value: number) => value + 1;\n");

    const result = await parseSourceFile({ filePath });
    const definitionNames = result.query
      .captures(result.tree.rootNode)
      .filter((capture) => capture.name.startsWith("name.definition"))
      .map((capture) => capture.node.text);

    expect(result.rootNodeType).toBe("program");
    expect(result.hasError).toBe(false);
    expect(definitionNames).toContain("stillWorks");
    result.dispose();
  });

  it("handles Windows-style backslash paths when selecting a language", () => {
    const descriptor = getTreeSitterLanguageForPath("src\\components\\view.tsx");

    expect(descriptor.languageId).toBe("tsx");
    expect(descriptor.grammarFileName).toBe("tree-sitter-tsx.wasm");
    expect(descriptor.queryFileName).toBe("typescript.scm");
  });
});
