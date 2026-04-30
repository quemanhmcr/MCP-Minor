import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_FILE_SKELETON_LIMIT,
  formatFileSkeletonCompact,
  formatFileSkeletonResult,
  getWorkspaceFileSkeleton,
  type SkeletonEntry,
} from "../src/filesystem/file-skeleton.js";
import type { RuntimeContext } from "../src/runtime/context.js";

describe("getWorkspaceFileSkeleton", () => {
  let workspaceRoot: string;
  let context: RuntimeContext;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-file-skeleton-"));
    context = {
      cwd: workspaceRoot,
      sessionId: "test-session",
      workspaceRoots: [workspaceRoot],
    };
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("extracts TypeScript functions, classes, interfaces, types, and enums", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "sample.ts"),
      [
        "import { readFile } from 'node:fs/promises';",
        "export interface Named {",
        "  getName(): string;",
        "}",
        "export type NameMap = Record<string, string>;",
        "export enum Mode {",
        "  Plan = 'plan',",
        "}",
        "export function buildName(value: string): string {",
        "  return value.trim();",
        "}",
        "export class Greeter implements Named {",
        "  getName(): string {",
        "    return buildName('Ada');",
        "  }",
        "}",
        "export const makeGreeter = (name: string) => new Greeter();",
        "",
      ].join("\n"),
    );

    const result = await getWorkspaceFileSkeleton(context, { paths: ["src/sample.ts"] });
    const file = result.files[0];
    const topLevel = file.entries.map((entry) => [entry.kind, entry.name, entry.location.startLine]);

    expect(file).toMatchObject({
      relativePath: "src/sample.ts",
      language: "typescript",
      rootType: "program",
      locationEncoding: "tree-sitter-utf8-byte-offsets",
      hasParseErrors: false,
      limit: DEFAULT_FILE_SKELETON_LIMIT,
      truncated: false,
    });
    expect(topLevel).toEqual([
      ["import", "node:fs/promises", 1],
      ["interface", "Named", 2],
      ["type", "NameMap", 5],
      ["enum", "Mode", 6],
      ["function", "buildName", 9],
      ["class", "Greeter", 12],
      ["function", "makeGreeter", 17],
    ]);
    expect(findEntry(file.entries, "Named")?.children.map((entry) => [entry.kind, entry.name])).toEqual([
      ["method", "getName"],
    ]);
    expect(findEntry(file.entries, "Greeter")?.children.map((entry) => [entry.kind, entry.name])).toEqual([
      ["method", "getName"],
    ]);
    expect(findEntry(file.entries, "buildName")?.signature).toBe("export function buildName(value: string): string");
    expect(findEntry(file.entries, "buildName")).toMatchObject({
      id: expect.stringMatching(/^S[0-9a-f]{8}$/u),
      qualifiedName: "buildName",
      signatureTruncated: false,
      containsParseErrors: false,
    });
    expect(findEntry(file.entries, "makeGreeter")?.signature).toBe(
      "export const makeGreeter = (name: string) => new Greeter();",
    );
  });

  it("extracts TSX function and class components", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "component.tsx"),
      [
        "import React from 'react';",
        "type Props = { name: string };",
        "export function Hello(props: Props) {",
        "  return <span>{props.name}</span>;",
        "}",
        "export const Inline = ({ name }: Props) => <strong>{name}</strong>;",
        "export class Panel extends React.Component<Props> {",
        "  render() {",
        "    return <Hello name={this.props.name} />;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const result = await getWorkspaceFileSkeleton(context, { paths: ["src/component.tsx"] });
    const file = result.files[0];

    expect(file.language).toBe("tsx");
    expect(file.hasParseErrors).toBe(false);
    expect(file.entries.map((entry) => [entry.kind, entry.name])).toEqual([
      ["import", "react"],
      ["type", "Props"],
      ["function", "Hello"],
      ["function", "Inline"],
      ["class", "Panel"],
    ]);
    expect(findEntry(file.entries, "Panel")?.children.map((entry) => entry.name)).toEqual(["render"]);
  });

  it("extracts JavaScript functions, classes, exports, and named arrows", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "module.mjs"),
      [
        "import path from 'node:path';",
        "export { path };",
        "export function createCounter() {",
        "  return new Counter();",
        "}",
        "class Counter {",
        "  increment() {",
        "    return 1;",
        "  }",
        "}",
        "export const makeCounter = () => new Counter();",
        "",
      ].join("\n"),
    );

    const result = await getWorkspaceFileSkeleton(context, { paths: ["src/module.mjs"] });
    const file = result.files[0];

    expect(file.language).toBe("javascript");
    expect(file.entries.map((entry) => [entry.kind, entry.name])).toEqual([
      ["import", "node:path"],
      ["export", "export"],
      ["function", "createCounter"],
      ["class", "Counter"],
      ["function", "makeCounter"],
    ]);
    expect(findEntry(file.entries, "Counter")?.children.map((entry) => [entry.kind, entry.name])).toEqual([
      ["method", "increment"],
    ]);
  });

  it("extracts JS and TS constructors consistently", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "constructors.js"),
      ["class JsBox {", "  constructor(value) {", "    this.value = value;", "  }", "}", ""].join("\n"),
    );
    await fs.writeFile(
      path.join(workspaceRoot, "src", "constructors.ts"),
      ["class TsBox {", "  constructor(readonly value: string) {}", "}", ""].join("\n"),
    );

    const result = await getWorkspaceFileSkeleton(context, {
      paths: ["src/constructors.js", "src/constructors.ts"],
    });

    expect(findEntry(result.files[0].entries, "JsBox")?.children.map((entry) => entry.name)).toEqual(["constructor"]);
    expect(findEntry(result.files[1].entries, "TsBox")?.children.map((entry) => entry.name)).toEqual(["constructor"]);
  });

  it("extracts multiple named arrow/function declarators from one declaration", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "multi.ts"),
      "export const first = () => 1, second = function () { return 2; };\n",
    );

    const result = await getWorkspaceFileSkeleton(context, { paths: ["src/multi.ts"] });
    const entries = result.files[0].entries;

    expect(entries.map((entry) => [entry.kind, entry.name])).toEqual([
      ["function", "first"],
      ["function", "second"],
    ]);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
  });

  it("uses declaration body fields for signatures instead of nested default parameter or heritage bodies", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "signatures.ts"),
      [
        "function deco(value: unknown) { return value; }",
        "@deco({ build: () => { return 1 } })",
        "class Decorated {",
        "  method() {}",
        "}",
        "function f(cb = () => { return 1 }, x = 1) { return x; }",
        "class D extends mixin({ trait: true }) {",
        "  method() {}",
        "}",
        "",
      ].join("\n"),
    );

    const result = await getWorkspaceFileSkeleton(context, { paths: ["src/signatures.ts"] });

    expect(findEntry(result.files[0].entries, "Decorated")?.signature).toBe(
      "@deco({ build: () => { return 1 } }) class Decorated",
    );
    expect(findEntry(result.files[0].entries, "f")?.signature).toBe(
      "function f(cb = () => { return 1 }, x = 1)",
    );
    expect(findEntry(result.files[0].entries, "D")?.signature).toBe("class D extends mixin({ trait: true })");
  });

  it("extracts anonymous default exports with stable fallback names", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "defaults.tsx"),
      [
        "export default function() {",
        "  return null;",
        "}",
        "export default class {",
        "  render() { return null; }",
        "}",
        "export default () => <span />;",
        "",
      ].join("\n"),
    );

    const result = await getWorkspaceFileSkeleton(context, { paths: ["src/defaults.tsx"] });

    expect(result.files[0].entries.map((entry) => [entry.kind, entry.name, entry.qualifiedName])).toEqual([
      ["function", "default", "default"],
      ["class", "default", "default"],
      ["function", "default", "default"],
    ]);
    expect(new Set(result.files[0].entries.map((entry) => entry.id)).size).toBe(3);
  });

  it("extracts JSX named arrow components", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "view.jsx"),
      [
        "import React from 'react';",
        "const Card = ({ title }) => <article>{title}</article>;",
        "export default Card;",
        "",
      ].join("\n"),
    );

    const result = await getWorkspaceFileSkeleton(context, { paths: ["src/view.jsx"] });
    const file = result.files[0];

    expect(file.hasParseErrors).toBe(false);
    expect(file.entries.map((entry) => [entry.kind, entry.name])).toEqual([
      ["import", "react"],
      ["function", "Card"],
      ["export", "export"],
    ]);
  });

  it("preserves nested class methods and nested function cases", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "nested.ts"),
      [
        "export class Outer {",
        "  run() {",
        "    const inner = () => 1;",
        "    return inner();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const result = await getWorkspaceFileSkeleton(context, { paths: ["src/nested.ts"] });
    const outer = findEntry(result.files[0].entries, "Outer");
    const run = outer?.children.find((entry) => entry.name === "run");

    expect(outer?.children.map((entry) => entry.name)).toEqual(["run"]);
    expect(run?.children.map((entry) => [entry.kind, entry.name])).toEqual([["function", "inner"]]);
  });

  it("keeps duplicate symbol names in different scopes", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "duplicates.ts"),
      [
        "export function save() { return 'top'; }",
        "export class Store {",
        "  save() { return 'method'; }",
        "}",
        "",
      ].join("\n"),
    );

    const result = await getWorkspaceFileSkeleton(context, { paths: ["src/duplicates.ts"] });
    const names = flattenEntries(result.files[0].entries).map((entry) => `${entry.kind}:${entry.name}:${entry.location.startLine}`);

    expect(names).toEqual(["function:save:1", "class:Store:2", "method:save:3"]);
  });

  it("returns an empty skeleton for empty files", async () => {
    await fs.writeFile(path.join(workspaceRoot, "src", "empty.ts"), "");

    const result = await getWorkspaceFileSkeleton(context, { paths: ["src/empty.ts"] });

    expect(result.files[0]).toMatchObject({
      rootType: "program",
      hasParseErrors: false,
      entries: [],
      entryCount: 0,
      truncated: false,
    });
  });

  it("surfaces parser errors in metadata while returning recoverable entries", async () => {
    await fs.writeFile(path.join(workspaceRoot, "src", "broken.ts"), "export function broken( {\n");

    const result = await getWorkspaceFileSkeleton(context, { paths: ["src/broken.ts"] });

    expect(result.files[0].hasParseErrors).toBe(true);
    expect(result.files[0].rootType).toBe("program");
  });

  it("marks entries whose range contains parse errors", async () => {
    await fs.writeFile(path.join(workspaceRoot, "src", "broken-entry.ts"), "export function broken() {\n  if (\n}\n");

    const result = await getWorkspaceFileSkeleton(context, { paths: ["src/broken-entry.ts"] });

    expect(result.files[0].hasParseErrors).toBe(true);
    expect(findEntry(result.files[0].entries, "broken")?.containsParseErrors).toBe(true);
  });

  it("keeps raw CRLF text and BOM-compatible parsing for source length and locations", async () => {
    const source = "\uFEFFexport function first() {\r\n\treturn 1;\r\n}\r\n";
    await fs.writeFile(path.join(workspaceRoot, "src", "crlf.ts"), source);

    const result = await getWorkspaceFileSkeleton(context, { paths: ["src/crlf.ts"] });
    const first = findEntry(result.files[0].entries, "first");

    expect(result.files[0].sourceLength).toBe(source.length);
    expect(result.files[0].hasParseErrors).toBe(false);
    expect(first?.location.startLine).toBe(1);
    expect(first?.location.endLine).toBe(3);
  });

  it("marks long signatures as truncated", async () => {
    const params = Array.from({ length: 80 }, (_, index) => `param${index}: string`).join(", ");
    await fs.writeFile(path.join(workspaceRoot, "src", "long.ts"), `export function long(${params}) { return ''; }\n`);

    const result = await getWorkspaceFileSkeleton(context, { paths: ["src/long.ts"] });
    const entry = findEntry(result.files[0].entries, "long");

    expect(entry?.signatureTruncated).toBe(true);
    expect(entry?.signature.endsWith("...")).toBe(true);
  });

  it("rejects unsupported extensions explicitly", async () => {
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# readme\n");

    await expect(getWorkspaceFileSkeleton(context, { paths: ["README.md"] })).rejects.toThrow(
      "Unsupported get_file_skeleton file extension '.md'",
    );
  });

  it("rejects missing files", async () => {
    await expect(getWorkspaceFileSkeleton(context, { paths: ["missing.ts"] })).rejects.toThrow(
      "Path 'missing.ts' does not exist.",
    );
  });

  it("rejects directories", async () => {
    await expect(getWorkspaceFileSkeleton(context, { paths: ["src"] })).rejects.toThrow(
      "Path 'src' is a directory, not a file.",
    );
  });

  it("rejects out-of-workspace paths", async () => {
    await expect(getWorkspaceFileSkeleton(context, { paths: [".."] })).rejects.toThrow(
      "outside the configured workspace roots",
    );
  });

  it("rejects symlinks when the platform allows symlink fixture creation", async () => {
    const target = path.join(workspaceRoot, "src", "target.ts");
    await fs.writeFile(target, "export const target = () => 1;\n");

    try {
      await fs.symlink(target, path.join(workspaceRoot, "src", "link.ts"));
    } catch (error) {
      if (isSymlinkPermissionError(error)) {
        return;
      }

      throw error;
    }

    await expect(getWorkspaceFileSkeleton(context, { paths: ["src/link.ts"] })).rejects.toThrow("symbolic link");
  });

  it("rejects binary-looking files before parsing", async () => {
    await fs.writeFile(path.join(workspaceRoot, "src", "binary.ts"), Buffer.from([0, 1, 2, 3]));

    await expect(getWorkspaceFileSkeleton(context, { paths: ["src/binary.ts"] })).rejects.toThrow(
      "binary or unsupported text",
    );
  });

  it("truncates skeleton entries by limit in preorder", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "limit.ts"),
      [
        "export function one() {}",
        "export class Box {",
        "  two() {}",
        "}",
        "export const three = () => 3;",
        "",
      ].join("\n"),
    );

    const result = await getWorkspaceFileSkeleton(context, { paths: ["src/limit.ts"], limit: 2 });

    expect(result.truncated).toBe(true);
    expect(result.files[0]).toMatchObject({
      entryCount: 4,
      limit: 2,
      truncated: true,
    });
    expect(flattenEntries(result.files[0].entries).map((entry) => entry.name)).toEqual(["one", "Box"]);
  });

  it("formats compact output with imports, symbols, parse markers, and truncation metadata", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "compact.ts"),
      [
        "import { readFile } from 'node:fs/promises';",
        "export interface Named {",
        "  getName(): string;",
        "}",
        "export type NameMap = Record<string, string>;",
        "export enum Mode { Plan = 'plan' }",
        "export default function() {",
        "  if (",
        "}",
        "",
      ].join("\n"),
    );

    const result = await getWorkspaceFileSkeleton(context, { paths: ["src/compact.ts"], limit: 4 });
    const compact = formatFileSkeletonResult(result);

    expect(compact).toContain("file:src/compact.ts | ts | 9L | n:6/4 | parse:err | trunc");
    expect(compact).toContain("trunc");
    expect(compact).toContain("imp: node:fs/promises{readFile}");
    expect(compact).toContain("iface Named L2-4");
    expect(compact).toContain("  fn getName L3");
    expect(compact).toContain("type NameMap L5");
    expect(compact).not.toContain("startByte");
    expect(compact).not.toContain('"id"');
  });

  it("formats compact anonymous default exports and per-entry parse error markers", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "src", "compact-defaults.ts"),
      [
        "export default function() {",
        "  return 1;",
        "}",
        "export class Broken {",
        "  run() {",
        "    if (",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const result = await getWorkspaceFileSkeleton(context, { paths: ["src/compact-defaults.ts"] });
    const compact = formatFileSkeletonResult(result);

    expect(compact).toContain("fn default L1-3 export default function()");
    expect(compact).toContain("cls Broken L4-8 export class Broken parse-error");
    expect(compact).toContain("  fn run L5-7 run() parse-error");
  });

  it("formats outline view without signatures and honors signature length budgets", async () => {
    const params = Array.from({ length: 20 }, (_, index) => `param${index}: string`).join(", ");
    await fs.writeFile(path.join(workspaceRoot, "src", "budget.ts"), `export function long(${params}): string { return ''; }\n`);

    const result = await getWorkspaceFileSkeleton(context, { paths: ["src/budget.ts"] });
    const outline = formatFileSkeletonCompact(result, { view: "outline" });
    const signatures = formatFileSkeletonCompact(result, { view: "signatures", maxSignatureChars: 48 });

    expect(outline).toContain("fn long L1");
    expect(outline).not.toContain("param0");
    expect(signatures).toContain("fn long L1 export function long(param0: string, param1:");
    expect(signatures).toContain("sig-trunc");
  });

  it("keeps React TSX generic-heavy signatures useful and bounded", async () => {
    const fixture = path.resolve("test", "fixtures", "react-generic-heavy.tsx");
    const source = await fs.readFile(fixture, "utf8");
    await fs.copyFile(fixture, path.join(workspaceRoot, "src", "react-generic-heavy.tsx"));

    const result = await getWorkspaceFileSkeleton(context, { paths: ["src/react-generic-heavy.tsx"] });
    const outline = formatFileSkeletonCompact(result, { view: "outline" });
    const signatures = formatFileSkeletonCompact(result, { view: "signatures" });
    const fullJson = JSON.stringify(result, null, 2);
    const file = result.files[0];
    const entries = flattenEntries(file.entries);

    expect(file.language).toBe("tsx");
    expect(file.hasParseErrors).toBe(false);
    expect(entries.map((entry) => [entry.kind, entry.name])).toEqual(
      expect.arrayContaining([
        ["interface", "TableColumn"],
        ["type", "AsyncState"],
        ["type", "DataTableProps"],
        ["function", "DataTable"],
        ["function", "ToolbarInner"],
        ["function", "withAsyncState"],
        ["function", "selectValue"],
      ]),
    );
    expect(signatures).toContain("export function DataTable<TData extends { id: string }, TMeta = Record<string, never>>");
    expect(signatures).toContain("export function withAsyncState<TProps extends object, TData>");
    expect(signatures).toContain("sig-trunc");
    expect(outline).not.toContain("TData extends");
    expect(signatures.length).toBeLessThan(source.length * 0.75);
    expect(outline.length).toBeLessThan(signatures.length);
    expect(signatures.length).toBeLessThan(fullJson.length * 0.45);
  });
});

describe("getWorkspaceFileSkeleton real Dirac repo smoke", () => {
  const repoRoot = path.resolve("..");
  const context: RuntimeContext = {
    cwd: repoRoot,
    sessionId: "real-repo-smoke",
    workspaceRoots: [repoRoot],
  };

  it.each([
    {
      filePath: "dirac/src/services/tree-sitter/languageParser.ts",
      language: "typescript",
      expected: [
        ["interface", "LanguageParser"],
        ["function", "loadRequiredLanguageParsers"],
      ],
    },
    {
      filePath: "dirac/src/core/task/tools/handlers/GetFileSkeletonToolHandler.ts",
      language: "typescript",
      expected: [
        ["class", "GetFileSkeletonToolHandler"],
        ["method", "execute"],
      ],
    },
    {
      filePath: "dirac/scripts/file-utils.mjs",
      language: "javascript",
      expected: [
        ["function", "writeFileWithMkdirs"],
        ["function", "rmrf"],
      ],
    },
  ])("extracts expected entries from $filePath", async ({ filePath, language, expected }) => {
    const result = await getWorkspaceFileSkeleton(context, { paths: [filePath] });
    const file = result.files[0];
    const compact = formatFileSkeletonResult(result);
    const fullJson = JSON.stringify(result, null, 2);
    const raw = await fs.readFile(path.join(repoRoot, filePath), "utf8");
    const flattened = flattenEntries(file.entries);
    const kindNamePairs = flattened.map((entry) => [entry.kind, entry.name]);

    expect(file.language).toBe(language);
    expect(file.rootType).toBe("program");
    expect(file.sourceLength).toBeGreaterThan(100);
    expect(file.hasParseErrors).toBe(false);
    expect(file.entryCount).toBeGreaterThanOrEqual(expected.length);
    for (const pair of expected) {
      expect(kindNamePairs).toContainEqual(pair);
    }
    expect(compact.length).toBeLessThan(fullJson.length * 0.5);
    if (filePath !== "dirac/scripts/file-utils.mjs") {
      expect(compact.length).toBeLessThan(raw.length * 0.8);
    }
  });
});

function findEntry(entries: SkeletonEntry[], name: string): SkeletonEntry | undefined {
  return flattenEntries(entries).find((entry) => entry.name === name);
}

function flattenEntries(entries: SkeletonEntry[]): SkeletonEntry[] {
  return entries.flatMap((entry) => [entry, ...flattenEntries(entry.children)]);
}

function isSymlinkPermissionError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES");
}
