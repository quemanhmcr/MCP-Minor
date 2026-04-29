import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatReadFileResult, readWorkspaceFiles } from "../src/filesystem/read-file.js";
import { MAX_EDIT_FILE_BYTES } from "../src/filesystem/edit-file-limits.js";
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
      editFileCompatibility: {
        editable: true,
        maxBytes: MAX_EDIT_FILE_BYTES,
      },
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

  it("marks ranged reads over the edit mutation cap as not editable by edit_file", async () => {
    await fs.writeFile(path.join(workspaceRoot, "too-large-to-edit.ts"), `first\n${"x".repeat(MAX_EDIT_FILE_BYTES)}\n`);

    const result = await readWorkspaceFiles(context, {
      paths: ["too-large-to-edit.ts"],
      startLine: 1,
      endLine: 1,
    });

    expect(result.files[0].editFileCompatibility).toEqual({
      editable: false,
      maxBytes: MAX_EDIT_FILE_BYTES,
      reason:
        "This file exceeds the 1MB edit mutation cap. read_file can inspect it with line ranges, but edit_file cannot mutate it.",
    });
    expect(result.files[0].content).toMatch(/^1: A[0-9a-f]{8}\u00a7first$/u);
    expect(result.files[0].truncated).toBe(false);
  });

  it("includes edit_file compatibility warnings in formatted read output", async () => {
    await fs.writeFile(path.join(workspaceRoot, "too-large-to-edit.ts"), `first\n${"x".repeat(MAX_EDIT_FILE_BYTES)}\n`);

    const result = await readWorkspaceFiles(context, {
      paths: ["too-large-to-edit.ts"],
      startLine: 1,
      endLine: 1,
    });

    expect(result.files[0].content).not.toContain("Edit File Warning");
    expect(formatReadFileResult(result)).toContain(
      "[Edit File Warning: This file exceeds the 1MB edit mutation cap. read_file can inspect it with line ranges, but edit_file cannot mutate it.]",
    );
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

  it("preserves surrounding anchors when a line is inserted", async () => {
    await fs.writeFile(path.join(workspaceRoot, "src", "main.ts"), "one\ntwo\nthree\n");
    const first = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });

    await fs.writeFile(path.join(workspaceRoot, "src", "main.ts"), "one\ninserted\ntwo\nthree\n");
    const second = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });

    const firstAnchors = anchorsByText(first.files[0].lines);
    const secondAnchors = anchorsByText(second.files[0].lines);

    expect(secondAnchors.get("one")).toBe(firstAnchors.get("one"));
    expect(secondAnchors.get("two")).toBe(firstAnchors.get("two"));
    expect(secondAnchors.get("three")).toBe(firstAnchors.get("three"));
    expect(secondAnchors.get("inserted")).not.toBe(firstAnchors.get("two"));
    expect(new Set(second.files[0].lines.map((line) => line.anchor)).size).toBe(second.files[0].lines.length);
  });

  it("preserves remaining anchors when a line is deleted", async () => {
    await fs.writeFile(path.join(workspaceRoot, "src", "main.ts"), "one\ntwo\nthree\nfour\n");
    const first = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });

    await fs.writeFile(path.join(workspaceRoot, "src", "main.ts"), "one\nthree\nfour\n");
    const second = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });

    const firstAnchors = anchorsByText(first.files[0].lines);
    const secondAnchors = anchorsByText(second.files[0].lines);

    expect(secondAnchors.get("one")).toBe(firstAnchors.get("one"));
    expect(secondAnchors.get("three")).toBe(firstAnchors.get("three"));
    expect(secondAnchors.get("four")).toBe(firstAnchors.get("four"));
    expect(second.files[0].lines.some((line) => line.anchor === firstAnchors.get("two"))).toBe(false);
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

  it("keeps duplicate identical lines as separate anchors", async () => {
    await fs.writeFile(path.join(workspaceRoot, "src", "main.ts"), "same\nsame\nsame\n");
    const first = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });
    const second = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });

    const firstAnchors = first.files[0].lines.map((line) => line.anchor);
    const secondAnchors = second.files[0].lines.map((line) => line.anchor);

    expect(new Set(firstAnchors).size).toBe(3);
    expect(secondAnchors).toEqual(firstAnchors);
  });

  it("preserves the best ordered duplicate anchors across insertion and deletion", async () => {
    await fs.writeFile(path.join(workspaceRoot, "src", "main.ts"), "header\nsame\nmiddle\nsame\nfooter\n");
    const first = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });
    const originalAnchors = first.files[0].lines.map((line) => line.anchor);

    await fs.writeFile(path.join(workspaceRoot, "src", "main.ts"), "header\nsame\ninserted\nsame\nfooter\n");
    const second = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });
    const nextAnchors = second.files[0].lines.map((line) => line.anchor);

    expect(nextAnchors[0]).toBe(originalAnchors[0]);
    expect(nextAnchors[1]).toBe(originalAnchors[1]);
    expect(nextAnchors[2]).not.toBe(originalAnchors[2]);
    expect(nextAnchors[3]).toBe(originalAnchors[3]);
    expect(nextAnchors[4]).toBe(originalAnchors[4]);
    expect(new Set(nextAnchors).size).toBe(nextAnchors.length);
  });

  it("does not preserve both anchors for a pure reorder", async () => {
    await fs.writeFile(path.join(workspaceRoot, "src", "main.ts"), "alpha\nbeta\n");
    const first = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });

    await fs.writeFile(path.join(workspaceRoot, "src", "main.ts"), "beta\nalpha\n");
    const second = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });

    const originalAnchors = new Set(first.files[0].lines.map((line) => line.anchor));
    const preservedCount = second.files[0].lines.filter((line) => originalAnchors.has(line.anchor)).length;

    expect(preservedCount).toBe(1);
    expect(new Set(second.files[0].lines.map((line) => line.anchor)).size).toBe(2);
  });

  it("scopes mutable anchor state by session", async () => {
    const first = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });
    const otherSession = await readWorkspaceFiles(
      {
        ...context,
        sessionId: "other-session",
      },
      { paths: ["src/main.ts"] },
    );

    expect(otherSession.files[0].lines.map((line) => line.anchor)).not.toEqual(
      first.files[0].lines.map((line) => line.anchor),
    );
  });

  it("returns a unique anchor and exact text pair for every output line", async () => {
    const result = await readWorkspaceFiles(context, { paths: ["src/main.ts"], startLine: 2, endLine: 4 });
    const lines = result.files[0].lines;

    expect(result.files[0].anchorDelimiter).toBe("\u00a7");
    expect(new Set(lines.map((line) => line.anchor)).size).toBe(lines.length);
    for (const line of lines) {
      expect(line.anchor).toMatch(/^A[0-9a-f]{8}$/u);
      expect(line.formatted).toBe(`${line.line}: ${line.anchor}\u00a7${line.text}`);
    }
  });
});

function anchorsByText(lines: Array<{ text: string; anchor: string }>): Map<string, string> {
  return new Map(lines.map((line) => [line.text, line.anchor]));
}

function isSymlinkPermissionError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES");
}
