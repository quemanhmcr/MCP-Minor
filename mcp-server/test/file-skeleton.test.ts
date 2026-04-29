import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_FILE_SKELETON_LIMIT,
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
