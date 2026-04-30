import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { editWorkspaceFile } from "../src/filesystem/edit-file.js";
import { readWorkspaceFiles } from "../src/filesystem/read-file.js";
import { resetAnchorState } from "../src/runtime/anchor-state.js";
import type { RuntimeContext } from "../src/runtime/context.js";

describe("editWorkspaceFile", () => {
  let workspaceRoot: string;
  let context: RuntimeContext;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-edit-file-"));
    context = {
      cwd: workspaceRoot,
      sessionId: "test-session",
      workspaceRoots: [workspaceRoot],
    };
    resetAnchorState();

    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "main.ts"), "alpha\nbeta\ngamma\ndelta\n");
  });

  afterEach(async () => {
    resetAnchorState();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("replaces a single line using a read_file anchor", async () => {
    const anchors = await readAnchors("src/main.ts");
    const result = await editWorkspaceFile(context, {
      path: "src/main.ts",
      edits: [{ anchor: anchors.beta, oldText: "beta", newText: "BETA" }],
    });

    await expect(readFile("src/main.ts")).resolves.toBe("alpha\nBETA\ngamma\ndelta\n");
    expect(result).toMatchObject({
      relativePath: "src/main.ts",
      changed: true,
      editsApplied: 1,
      lineEnding: "lf",
      appliedEdits: [
        {
          anchor: anchors.beta,
          startLine: 2,
          endLine: 2,
          oldText: "beta",
          newText: "BETA",
          linesRemoved: 1,
          linesAdded: 1,
        },
      ],
    });
  });

  it("replaces multiple lines from the start anchor and oldText span", async () => {
    const anchors = await readAnchors("src/main.ts");

    await editWorkspaceFile(context, {
      path: "src/main.ts",
      edits: [{ anchor: anchors.beta, oldText: "beta\ngamma", newText: "one\ntwo\nthree" }],
    });

    await expect(readFile("src/main.ts")).resolves.toBe("alpha\none\ntwo\nthree\ndelta\n");
  });

  it("applies multiple non-overlapping edits in one file", async () => {
    const anchors = await readAnchors("src/main.ts");

    const result = await editWorkspaceFile(context, {
      path: "src/main.ts",
      edits: [
        { anchor: anchors.alpha, oldText: "alpha", newText: "ALPHA" },
        { anchor: anchors.delta, oldText: "delta", newText: "DELTA" },
      ],
    });

    await expect(readFile("src/main.ts")).resolves.toBe("ALPHA\nbeta\ngamma\nDELTA\n");
    expect(result.editsApplied).toBe(2);
    expect(result.appliedEdits.map((edit) => edit.startLine)).toEqual([1, 4]);
  });

  it("applies bottom-to-top so earlier replacements do not shift later edits", async () => {
    const anchors = await readAnchors("src/main.ts");

    await editWorkspaceFile(context, {
      path: "src/main.ts",
      edits: [
        { anchor: anchors.beta, oldText: "beta", newText: "b1\nb2\nb3" },
        { anchor: anchors.delta, oldText: "delta", newText: "D" },
      ],
    });

    await expect(readFile("src/main.ts")).resolves.toBe("alpha\nb1\nb2\nb3\ngamma\nD\n");
  });

  it("rejects overlapping edits", async () => {
    const anchors = await readAnchors("src/main.ts");

    await expect(
      editWorkspaceFile(context, {
        path: "src/main.ts",
        edits: [
          { anchor: anchors.beta, oldText: "beta\ngamma", newText: "x" },
          { anchor: anchors.gamma, oldText: "gamma", newText: "y" },
        ],
      }),
    ).rejects.toThrow("Overlapping edits");

    await expect(readFile("src/main.ts")).resolves.toBe("alpha\nbeta\ngamma\ndelta\n");
  });

  it("rejects unknown anchors", async () => {
    await readAnchors("src/main.ts");

    await expect(
      editWorkspaceFile(context, {
        path: "src/main.ts",
        edits: [{ anchor: "Affffffff", oldText: "beta", newText: "BETA" }],
      }),
    ).rejects.toThrow("is not known");
  });

  it("rejects when anchor state is missing after reset or restart", async () => {
    const anchors = await readAnchors("src/main.ts");
    resetAnchorState(context.sessionId);

    await expect(
      editWorkspaceFile(context, {
        path: "src/main.ts",
        edits: [{ anchor: anchors.beta, oldText: "beta", newText: "BETA" }],
      }),
    ).rejects.toThrow('Path \'src/main.ts\' has no edit-ready anchor state. Call read_file with view: "edit" before edit_file.');

    await expect(readFile("src/main.ts")).resolves.toBe("alpha\nbeta\ngamma\ndelta\n");
  });

  it("rejects stale anchor state after external line-count changes", async () => {
    const anchors = await readAnchors("src/main.ts");
    await fs.writeFile(path.join(workspaceRoot, "src", "main.ts"), "inserted\nalpha\nbeta\ngamma\ndelta\n");

    await expect(
      editWorkspaceFile(context, {
        path: "src/main.ts",
        edits: [{ anchor: anchors.beta, oldText: "beta", newText: "BETA" }],
      }),
    ).rejects.toThrow("changed since the last read_file in this session");
  });

  it("rejects same-line-count external modifications before target edit", async () => {
    const anchors = await readAnchors("src/main.ts");
    await fs.writeFile(path.join(workspaceRoot, "src", "main.ts"), "alpha\nBETA\ngamma\ndelta\n");

    await expect(
      editWorkspaceFile(context, {
        path: "src/main.ts",
        edits: [{ anchor: anchors.gamma, oldText: "gamma", newText: "GAMMA" }],
      }),
    ).rejects.toThrow("changed since the last read_file in this session");

    await expect(readFile("src/main.ts")).resolves.toBe("alpha\nBETA\ngamma\ndelta\n");
  });

  it("rejects same-line-count cross-session stale edits", async () => {
    const sessionA: RuntimeContext = { ...context, sessionId: "session-a" };
    const sessionB: RuntimeContext = { ...context, sessionId: "session-b" };
    const anchorsA = await readAnchorsFor(sessionA, "src/main.ts");
    const anchorsB = await readAnchorsFor(sessionB, "src/main.ts");

    await editWorkspaceFile(sessionA, {
      path: "src/main.ts",
      edits: [{ anchor: anchorsA.beta, oldText: "beta", newText: "BETA" }],
    });

    await expect(
      editWorkspaceFile(sessionB, {
        path: "src/main.ts",
        edits: [{ anchor: anchorsB.gamma, oldText: "gamma", newText: "GAMMA" }],
      }),
    ).rejects.toThrow("changed since the last read_file in this session");

    await expect(readFile("src/main.ts")).resolves.toBe("alpha\nBETA\ngamma\ndelta\n");
  });

  it("succeeds after re-reading following an external same-line-count modification", async () => {
    await readAnchors("src/main.ts");
    await fs.writeFile(path.join(workspaceRoot, "src", "main.ts"), "alpha\nBETA\ngamma\ndelta\n");

    const refreshed = await readAnchors("src/main.ts");
    await editWorkspaceFile(context, {
      path: "src/main.ts",
      edits: [{ anchor: refreshed.gamma, oldText: "gamma", newText: "GAMMA" }],
    });

    await expect(readFile("src/main.ts")).resolves.toBe("alpha\nBETA\nGAMMA\ndelta\n");
  });

  it("rejects oldText mismatches", async () => {
    const anchors = await readAnchors("src/main.ts");

    await expect(
      editWorkspaceFile(context, {
        path: "src/main.ts",
        edits: [{ anchor: anchors.beta, oldText: "wrong", newText: "BETA" }],
      }),
    ).rejects.toThrow("oldText mismatch");

    await expect(readFile("src/main.ts")).resolves.toBe("alpha\nbeta\ngamma\ndelta\n");
  });

  it("does not partially write when one of multiple edits fails", async () => {
    const anchors = await readAnchors("src/main.ts");

    await expect(
      editWorkspaceFile(context, {
        path: "src/main.ts",
        edits: [
          { anchor: anchors.alpha, oldText: "alpha", newText: "ALPHA" },
          { anchor: anchors.gamma, oldText: "wrong", newText: "GAMMA" },
        ],
      }),
    ).rejects.toThrow("oldText mismatch");

    await expect(readFile("src/main.ts")).resolves.toBe("alpha\nbeta\ngamma\ndelta\n");
  });

  it("does not partially write when stale hash mismatch occurs in a multi-edit call", async () => {
    const anchors = await readAnchors("src/main.ts");
    await fs.writeFile(path.join(workspaceRoot, "src", "main.ts"), "alpha\nBETA\ngamma\ndelta\n");

    await expect(
      editWorkspaceFile(context, {
        path: "src/main.ts",
        edits: [
          { anchor: anchors.alpha, oldText: "alpha", newText: "ALPHA" },
          { anchor: anchors.gamma, oldText: "gamma", newText: "GAMMA" },
        ],
      }),
    ).rejects.toThrow("changed since the last read_file in this session");

    await expect(readFile("src/main.ts")).resolves.toBe("alpha\nBETA\ngamma\ndelta\n");
  });

  it("refreshes anchor state after successful edits", async () => {
    const first = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });
    const alphaAnchor = first.files[0].lines[0].anchor;
    const betaAnchor = first.files[0].lines[1].anchor;

    await editWorkspaceFile(context, {
      path: "src/main.ts",
      edits: [{ anchor: betaAnchor, oldText: "beta", newText: "BETA" }],
    });

    const second = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });
    expect(second.files[0].lines.map((line) => line.text)).toEqual(["alpha", "BETA", "gamma", "delta"]);
    expect(second.files[0].lines[0].anchor).toBe(alphaAnchor);
    expect(second.files[0].lines[1].anchor).not.toBe(betaAnchor);
  });

  it("supports subsequent read_file output for another anchored edit", async () => {
    const anchors = await readAnchors("src/main.ts");
    await editWorkspaceFile(context, {
      path: "src/main.ts",
      edits: [{ anchor: anchors.beta, oldText: "beta", newText: "BETA" }],
    });

    const updated = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });
    const updatedBeta = updated.files[0].lines.find((line) => line.text === "BETA");
    expect(updatedBeta).toBeDefined();

    await editWorkspaceFile(context, {
      path: "src/main.ts",
      edits: [{ anchor: updatedBeta!.anchor, oldText: "BETA", newText: "beta2" }],
    });

    await expect(readFile("src/main.ts")).resolves.toBe("alpha\nbeta2\ngamma\ndelta\n");
  });

  it("refreshes stored hash after successful write for a subsequent edit using updated anchors", async () => {
    const anchors = await readAnchors("src/main.ts");
    await editWorkspaceFile(context, {
      path: "src/main.ts",
      edits: [{ anchor: anchors.beta, oldText: "beta", newText: "BETA" }],
    });

    const updated = await readWorkspaceFiles(context, { paths: ["src/main.ts"] });
    const gammaAnchor = updated.files[0].lines.find((line) => line.text === "gamma")?.anchor;
    expect(gammaAnchor).toBeDefined();

    await editWorkspaceFile(context, {
      path: "src/main.ts",
      edits: [{ anchor: gammaAnchor!, oldText: "gamma", newText: "GAMMA" }],
    });

    await expect(readFile("src/main.ts")).resolves.toBe("alpha\nBETA\nGAMMA\ndelta\n");
  });

  it("rejects missing files", async () => {
    await expect(editWorkspaceFile(context, { path: "missing.ts", edits: [dummyEdit()] })).rejects.toThrow(
      "does not exist",
    );
  });

  it("rejects directories", async () => {
    await expect(editWorkspaceFile(context, { path: "src", edits: [dummyEdit()] })).rejects.toThrow(
      "is a directory",
    );
  });

  it("rejects paths outside the workspace", async () => {
    await expect(editWorkspaceFile(context, { path: "..", edits: [dummyEdit()] })).rejects.toThrow(
      "outside the configured workspace roots",
    );
  });

  it("rejects symlinks", async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-mcp-edit-file-outside-"));

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

      await expect(editWorkspaceFile(context, { path: "link.txt", edits: [dummyEdit()] })).rejects.toThrow(
        "symbolic link",
      );
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects binary-looking files", async () => {
    await fs.writeFile(path.join(workspaceRoot, "blob.bin"), Buffer.from([0, 1, 2, 3, 4]));

    await expect(editWorkspaceFile(context, { path: "blob.bin", edits: [dummyEdit()] })).rejects.toThrow(
      "binary or unsupported text",
    );
  });

  it("rejects oversized files", async () => {
    await fs.writeFile(path.join(workspaceRoot, "large.txt"), `${"x".repeat(1024 * 1024 + 1)}\n`);

    await expect(editWorkspaceFile(context, { path: "large.txt", edits: [dummyEdit()] })).rejects.toThrow(
      "exceeds the 1MB edit mutation cap",
    );
  });

  it("returns deterministic diff output", async () => {
    const anchors = await readAnchors("src/main.ts");

    const result = await editWorkspaceFile(context, {
      path: "src/main.ts",
      edits: [{ anchor: anchors.beta, oldText: "beta", newText: "BETA\nBETA2" }],
    });

    expect(result.diff).toBe(["*** Update File: src/main.ts", "@@ 2,1 -> 2 @@", "-beta", "+BETA", "+BETA2"].join("\n"));
  });

  it("preserves CRLF line endings when writing", async () => {
    await fs.writeFile(path.join(workspaceRoot, "src", "main.ts"), "alpha\r\nbeta\r\ngamma\r\n");
    const anchors = await readAnchors("src/main.ts");

    const result = await editWorkspaceFile(context, {
      path: "src/main.ts",
      edits: [{ anchor: anchors.beta, oldText: "beta", newText: "BETA" }],
    });

    await expect(readFile("src/main.ts")).resolves.toBe("alpha\r\nBETA\r\ngamma\r\n");
    expect(result.lineEnding).toBe("crlf");
  });

  async function readAnchors(relativePath: string): Promise<Record<string, string>> {
    return readAnchorsFor(context, relativePath);
  }

  async function readAnchorsFor(readContext: RuntimeContext, relativePath: string): Promise<Record<string, string>> {
    const result = await readWorkspaceFiles(readContext, { paths: [relativePath] });
    return Object.fromEntries(result.files[0].lines.map((line) => [line.text, line.anchor]));
  }

  async function readFile(relativePath: string): Promise<string> {
    return fs.readFile(path.join(workspaceRoot, relativePath), "utf8");
  }
});

function dummyEdit() {
  return {
    anchor: "A00000000",
    oldText: "x",
    newText: "y",
  };
}

function isSymlinkPermissionError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES");
}
