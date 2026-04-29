import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { listWorkspaceFiles } from "../src/filesystem/list-files.js";
import type { RuntimeContext } from "../src/runtime/context.js";

describe("listWorkspaceFiles", () => {
  let workspaceRoot: string;
  let context: RuntimeContext;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-list-files-"));
    context = {
      cwd: workspaceRoot,
      sessionId: "test",
      workspaceRoots: [workspaceRoot],
    };

    await fs.mkdir(path.join(workspaceRoot, "src", "nested"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "dist"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "readme");
    await fs.writeFile(path.join(workspaceRoot, "src", "a.ts"), "a");
    await fs.writeFile(path.join(workspaceRoot, "src", "nested", "b.ts"), "b");
    await fs.writeFile(path.join(workspaceRoot, "docs", "guide.md"), "guide");
    await fs.writeFile(path.join(workspaceRoot, "node_modules", "pkg", "index.js"), "ignored");
    await fs.writeFile(path.join(workspaceRoot, "dist", "bundle.js"), "ignored");
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("lists a directory non-recursively", async () => {
    const result = await listWorkspaceFiles(context, { paths: ["src"], recursive: false });

    expect(result.truncated).toBe(false);
    expect(result.entries).toEqual([
      {
        path: path.join(workspaceRoot, "src", "a.ts"),
        type: "file",
        relativePath: "src/a.ts",
      },
      {
        path: path.join(workspaceRoot, "src", "nested"),
        type: "directory",
        relativePath: "src/nested",
      },
    ]);
  });

  it("lists a directory recursively", async () => {
    const result = await listWorkspaceFiles(context, { paths: ["src"], recursive: true });

    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["src/a.ts", "src/nested", "src/nested/b.ts"]);
  });

  it("lists multiple paths", async () => {
    const result = await listWorkspaceFiles(context, { paths: ["src/a.ts", "docs"], recursive: false });

    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["src/a.ts", "docs/guide.md"]);
  });

  it("excludes ignored generated directories", async () => {
    const result = await listWorkspaceFiles(context, { paths: ["."], recursive: true });

    expect(result.entries.map((entry) => entry.relativePath)).not.toContain("node_modules");
    expect(result.entries.map((entry) => entry.relativePath)).not.toContain("node_modules/pkg/index.js");
    expect(result.entries.map((entry) => entry.relativePath)).not.toContain("dist");
    expect(result.entries.map((entry) => entry.relativePath)).not.toContain("dist/bundle.js");
  });

  it("applies the result limit across all paths", async () => {
    const result = await listWorkspaceFiles(context, { paths: ["src", "docs"], recursive: true, limit: 2 });

    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])("rejects invalid limit value %s", async (limit) => {
    await expect(listWorkspaceFiles(context, { paths: ["src"], limit })).rejects.toThrow(
      "limit must be a positive integer",
    );
  });

  it("clamps oversized limit values to the maximum", async () => {
    const result = await listWorkspaceFiles(context, { paths: ["src"], recursive: true, limit: 10_000 });

    expect(result.limit).toBe(1_000);
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["src/a.ts", "src/nested", "src/nested/b.ts"]);
  });

  it("deduplicates duplicate paths while preserving deterministic order", async () => {
    const result = await listWorkspaceFiles(context, { paths: ["src", "src", "src/a.ts"], recursive: true });

    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["src/a.ts", "src/nested", "src/nested/b.ts"]);
  });

  it("fails fast when a path does not exist", async () => {
    await expect(listWorkspaceFiles(context, { paths: ["src/a.ts", "missing.ts"], recursive: false })).rejects.toThrow(
      "Path 'missing.ts' does not exist.",
    );
  });

  it("rejects paths outside the workspace", async () => {
    await expect(listWorkspaceFiles(context, { paths: [".."], recursive: false })).rejects.toThrow(
      "outside the configured workspace roots",
    );
  });

  it("rejects malformed paths when called directly", async () => {
    await expect(listWorkspaceFiles(context, { paths: [] })).rejects.toThrow("paths must be a non-empty array");
    await expect(listWorkspaceFiles(context, { paths: [""] })).rejects.toThrow("non-empty strings");
  });
});
