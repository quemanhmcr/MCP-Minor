import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { searchWorkspaceFiles } from "../src/filesystem/search-files.js";
import type { RuntimeContext } from "../src/runtime/context.js";

describe("searchWorkspaceFiles", () => {
  let workspaceRoot: string;
  let context: RuntimeContext;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-search-files-"));
    context = {
      cwd: workspaceRoot,
      sessionId: "test",
      workspaceRoots: [workspaceRoot],
    };

    await fs.mkdir(path.join(workspaceRoot, "src", "nested"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "dist"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "coverage"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "a.ts"), "alpha\nconst target = 1;\nomega\n");
    await fs.writeFile(path.join(workspaceRoot, "src", "nested", "b.ts"), "export const nestedTarget = true;\n");
    await fs.writeFile(path.join(workspaceRoot, "docs", "guide.md"), "target in docs\n");
    await fs.writeFile(path.join(workspaceRoot, "node_modules", "pkg", "index.js"), "target in dependency\n");
    await fs.writeFile(path.join(workspaceRoot, "dist", "bundle.js"), "target in build output\n");
    await fs.writeFile(path.join(workspaceRoot, "coverage", "report.txt"), "target in coverage\n");
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("returns basic regex matches with deterministic structured output", async () => {
    const result = await searchWorkspaceFiles(context, { paths: ["src"], regex: "target" });

    expect(result).toEqual({
      matches: [
        {
          path: path.join(workspaceRoot, "src", "a.ts"),
          relativePath: "src/a.ts",
          line: 2,
          column: 7,
          match: "target",
        },
      ],
      limit: 100,
      truncated: false,
    });
  });

  it("searches multiple paths", async () => {
    const result = await searchWorkspaceFiles(context, { paths: ["src", "docs"], regex: "target" });

    expect(result.matches.map((entry) => entry.relativePath)).toEqual(["docs/guide.md", "src/a.ts"]);
  });

  it("filters files by filePattern", async () => {
    const result = await searchWorkspaceFiles(context, {
      paths: ["."],
      regex: "target",
      filePattern: "*.md",
    });

    expect(result.matches.map((entry) => entry.relativePath)).toEqual(["docs/guide.md"]);
  });

  it("skips generated directories", async () => {
    const result = await searchWorkspaceFiles(context, { paths: ["."], regex: "target" });

    expect(result.matches.map((entry) => entry.relativePath)).toEqual(["docs/guide.md", "src/a.ts"]);
    expect(result.matches.map((entry) => entry.relativePath)).not.toContain("node_modules/pkg/index.js");
    expect(result.matches.map((entry) => entry.relativePath)).not.toContain("dist/bundle.js");
    expect(result.matches.map((entry) => entry.relativePath)).not.toContain("coverage/report.txt");
  });

  it("returns bounded context preview when requested", async () => {
    const result = await searchWorkspaceFiles(context, { paths: ["src/a.ts"], regex: "target", contextLines: 1 });

    expect(result.matches[0]).toMatchObject({
      relativePath: "src/a.ts",
      preview: [
        { line: 1, text: "alpha", match: false },
        { line: 2, text: "const target = 1;", match: true },
        { line: 3, text: "omega", match: false },
      ],
    });
  });

  it("applies limit and reports truncation", async () => {
    const result = await searchWorkspaceFiles(context, { paths: ["."], regex: "target", limit: 1 });

    expect(result.matches).toHaveLength(1);
    expect(result.limit).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("returns ripgrep invalid regex errors clearly", async () => {
    await expect(searchWorkspaceFiles(context, { paths: ["."], regex: "[" })).rejects.toThrow(/regex|parse/i);
  });

  it("rejects paths outside the workspace", async () => {
    await expect(searchWorkspaceFiles(context, { paths: [".."], regex: "target" })).rejects.toThrow(
      "outside the configured workspace roots",
    );
  });

  it("returns a clear error when ripgrep is missing", async () => {
    await expect(
      searchWorkspaceFiles(context, { paths: ["."], regex: "target" }, { rgCommand: "definitely-missing-rg-command" }),
    ).rejects.toThrow("ripgrep executable 'rg' was not found on PATH");
  });
});
