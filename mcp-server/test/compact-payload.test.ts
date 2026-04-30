import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { compactFileSkeletonResult, formatFileSkeletonCompact, getWorkspaceFileSkeleton } from "../src/filesystem/file-skeleton.js";
import { compactGetFunctionResult, getWorkspaceFunctions } from "../src/filesystem/get-function.js";
import { compactListFilesResult, listWorkspaceFiles } from "../src/filesystem/list-files.js";
import { compactReadFileResult, formatReadFileResult, readWorkspaceFiles } from "../src/filesystem/read-file.js";
import { compactSearchFilesResult, searchWorkspaceFiles } from "../src/filesystem/search-files.js";
import type { RuntimeContext } from "../src/runtime/context.js";

describe("compact MCP payload contracts", () => {
  let workspaceRoot: string;
  let context: RuntimeContext;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-compact-payload-"));
    context = {
      cwd: workspaceRoot,
      sessionId: "compact-payload",
      workspaceRoots: [workspaceRoot],
    };
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "src", "file.tsx"),
      [
        "import React from 'react';",
        "export interface Props<T> { value: T }",
        "export function Component<T>(props: Props<T>) {",
        "  const searchable = String(props.value);",
        "  return <span>{searchable}</span>;",
        "}",
        "",
      ].join("\n"),
    );
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# searchable\n");
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("keeps compact structuredContent summary-only for default views", async () => {
    const list = await listWorkspaceFiles(context, { paths: ["."], recursive: true });
    const search = await searchWorkspaceFiles(context, { paths: ["."], regex: "searchable" });
    const read = await readWorkspaceFiles(context, { paths: ["src/file.tsx"], includeAnchors: false });
    const skeleton = await getWorkspaceFileSkeleton(context, { paths: ["src/file.tsx"] });
    const functions = await getWorkspaceFunctions(context, { paths: ["src/file.tsx"], function_names: ["Component"] });

    const cases = [
      ["list_files outline", compactListFilesResult(list), 80],
      ["search_files matches", compactSearchFilesResult(search, { view: "matches" }), 90],
      ["search_files files", compactSearchFilesResult(search, { view: "files" }), 90],
      ["read_file read", compactReadFileResult(read, { includeAnchors: false }), 260],
      ["get_file_skeleton outline", compactFileSkeletonResult(skeleton, { view: "outline" }), 240],
      ["get_file_skeleton signatures", compactFileSkeletonResult(skeleton, { view: "signatures" }), 240],
      ["get_function source", compactGetFunctionResult(functions), 240],
    ] as const;

    for (const [name, structuredContent, maxJsonChars] of cases) {
      const json = JSON.stringify(structuredContent);
      expect(json.length, name).toBeLessThanOrEqual(maxJsonChars);
      expect(json, name).not.toContain("path\":\"");
      expect(json, name).not.toContain("lines");
      expect(json, name).not.toContain("entries\":[");
      expect(json, name).not.toContain("matches\":[");
    }
  });

  it("keeps read view under the compact MCP-visible budget on a representative large source file", async () => {
    const repoRoot = path.resolve("..");
    const repoContext: RuntimeContext = {
      cwd: repoRoot,
      sessionId: "compact-read-budget",
      workspaceRoots: [repoRoot],
    };
    const file = "mcp-server/src/filesystem/file-skeleton.ts";
    const raw = await fs.readFile(path.join(repoRoot, file), "utf8");
    const result = await readWorkspaceFiles(repoContext, { paths: [file], includeAnchors: false });
    const totalMcpVisibleChars =
      formatReadFileResult(result, { includeAnchors: false }).length +
      JSON.stringify(compactReadFileResult(result, { includeAnchors: false })).length;

    expect(totalMcpVisibleChars / raw.length).toBeLessThanOrEqual(1.1);
  });

  it("keeps full views rich while compact views stay lean", async () => {
    const skeleton = await getWorkspaceFileSkeleton(context, { paths: ["src/file.tsx"] });
    const compact = compactFileSkeletonResult(skeleton, { view: "signatures" });
    const full = skeleton.files[0];

    expect(JSON.stringify(compact)).not.toContain("startByte");
    expect(JSON.stringify(compact)).not.toContain("\"id\"");
    expect(full.entries[0]).toHaveProperty("id");
    expect(full.entries[0]).toHaveProperty("location.startByte");
    expect(full.entries[0]).toHaveProperty("children");
    expect(formatFileSkeletonCompact(skeleton, { view: "signatures" })).toContain("export interface Props<T>");
  });
});
