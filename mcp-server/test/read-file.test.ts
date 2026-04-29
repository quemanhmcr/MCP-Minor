import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readWorkspaceFiles } from "../src/filesystem/read-file.js";
import type { RuntimeContext } from "../src/runtime/context.js";
import { resetAnchorState } from "../src/runtime/anchor-state.js";

describe("readWorkspaceFiles", () => {
  let workspaceRoot: string;
  let context: RuntimeContext;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-read-file-"));
    context = {
      cwd: workspaceRoot,
      sessionId: "test-session",
      workspaceRoots: [workspaceRoot],
    };
    resetAnchorState();

    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "main.ts"), "one\n two\nthree\nfour\n");
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# Readme\n\nbody\n");
  });

  afterEach(async () => {
    resetAnchorState();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("reads a full text file with line numbers and anchors", async () => {
    const result = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });

    expect(result.truncated).toBe(false);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      path: path.join(workspaceRoot, "src", "main.ts"),
      relativePath: "src/main.ts",
      totalLines: 4,
      startLine: 1,
      endLine: 4,
      truncated: false,
    });
    expect(result.files[0].lines.map((line) => line.line)).toEqual([1, 2, 3, 4]);
    expect(result.files[0].lines[0].formatted).toMatch(/^1: A[0-9a-f]{8}§one$/u);
    expect(result.files[0].content).toContain("2: ");
  });

  it("reads explicit inclusive line ranges", async () => {
    const result = await readWorkspaceFiles(context, { paths: ["src/main.ts"], startLine: 2, endLine: 3 });

    expect(result.files[0].startLine).toBe(2);
    expect(result.files[0].endLine).toBe(3);
    expect(result.files[0].lines.map((line) => ({ line: line.line, text: line.text }))).toEqual([
      { line: 2, text: " two" },
      { line: 3, text: "three" },
    ]);
  });

  it("supports Dirac-compatible snake_case line range aliases", async () => {
    const result = await readWorkspaceFiles(context, { paths: ["src/main.ts"], start_line: 4 });

    expect(result.files[0].lines.map((line) => line.line)).toEqual([4]);
    expect(result.files[0].lines[0].text).toBe("four");
  });

  it("bounds ranges past end of file", async () => {
    const result = await readWorkspaceFiles(context, { paths: ["src/main.ts"], startLine: 3, endLine: 99 });

    expect(result.files[0].endLine).toBe(4);
    expect(result.files[0].lines.map((line) => line.text)).toEqual(["three", "four"]);
  });

  it.each([
    { startLine: 0 },
    { endLine: -1 },
    { startLine: 4, endLine: 2 },
    { startLine: 1.5 },
  ])("rejects invalid line range %#", async (range) => {
    await expect(readWorkspaceFiles(context, { paths: ["src/main.ts"], ...range })).rejects.toThrow(
      /startLine|endLine/,
    );
  });

  it("rejects a missing file", async () => {
    await expect(readWorkspaceFiles(context, { paths: ["missing.ts"] })).rejects.toThrow(
      "Path 'missing.ts' does not exist.",
    );
  });

  it("rejects paths outside the workspace", async () => {
    await expect(readWorkspaceFiles(context, { paths: [".."] })).rejects.toThrow(
      "outside the configured workspace roots",
    );
  });

  it("rejects directory paths", async () => {
    await expect(readWorkspaceFiles(context, { paths: ["src"] })).rejects.toThrow(
      "Path 'src' is a directory, not a file.",
    );
  });

  it("rejects direct symlink reads", async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-read-file-outside-"));

    try {
      await fs.writeFile(path.join(outsideRoot, "secret.txt"), "secret");

      try {
        await fs.symlink(path.join(outsideRoot, "secret.txt"), path.join(workspaceRoot, "link.txt"));
      } catch (error) {
        if (isSymlinkPermissionError(error)) {
          return;
        }

        throw error;
      }

      await expect(readWorkspaceFiles(context, { paths: ["link.txt"] })).rejects.toThrow("symbolic link");
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects unsupported generated or rich file types explicitly", async () => {
    await fs.writeFile(path.join(workspaceRoot, "paper.pdf"), "%PDF-1.7");

    await expect(readWorkspaceFiles(context, { paths: ["paper.pdf"] })).rejects.toThrow(
      "currently supports text/code files only",
    );
  });

  it("rejects binary-looking files", async () => {
    await fs.writeFile(path.join(workspaceRoot, "blob.bin"), Buffer.from([0, 1, 2, 3, 4]));

    await expect(readWorkspaceFiles(context, { paths: ["blob.bin"] })).rejects.toThrow("binary or unsupported text");
  });

  it("requires line ranges for full reads over 50KB", async () => {
    await fs.writeFile(path.join(workspaceRoot, "large.txt"), `${"x".repeat(60 * 1024)}\nlast`);

    await expect(readWorkspaceFiles(context, { paths: ["large.txt"] })).rejects.toThrow("limit for full file reads");

    const result = await readWorkspaceFiles(context, { paths: ["large.txt"], startLine: 2, endLine: 2 });
    expect(result.files[0].lines[0].text).toBe("last");
  });

  it("caps large ranged output by line limit", async () => {
    const content = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n");
    await fs.writeFile(path.join(workspaceRoot, "many.txt"), content);

    const result = await readWorkspaceFiles(context, { paths: ["many.txt"], lineLimit: 5 });

    expect(result.truncated).toBe(true);
    expect(result.files[0].lines).toHaveLength(5);
    expect(result.files[0].endLine).toBe(5);
  });

  it("reads multiple files when requested", async () => {
    const result = await readWorkspaceFiles(context, { paths: ["README.md", "src/main.ts"], endLine: 1 });

    expect(result.files.map((file) => file.relativePath)).toEqual(["README.md", "src/main.ts"]);
    expect(result.files.map((file) => file.lines[0].line)).toEqual([1, 1]);
  });

  it("keeps anchors stable for identical file content in the same session", async () => {
    const first = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });
    const second = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });

    expect(second.files[0].lines.map((line) => line.anchor)).toEqual(first.files[0].lines.map((line) => line.anchor));
  });

  it("changes anchors for changed lines while preserving unchanged lines", async () => {
    const first = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });
    await fs.writeFile(path.join(workspaceRoot, "src", "main.ts"), "one\nchanged\nthree\nfour\n");
    const second = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });

    expect(second.files[0].fileHash).not.toBe(first.files[0].fileHash);
    expect(second.files[0].lines[0].anchor).toBe(first.files[0].lines[0].anchor);
    expect(second.files[0].lines[1].anchor).not.toBe(first.files[0].lines[1].anchor);
    expect(second.files[0].lines[2].anchor).toBe(first.files[0].lines[2].anchor);
  });
});

function isSymlinkPermissionError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES");
}
