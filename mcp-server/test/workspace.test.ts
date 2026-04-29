import path from "node:path";

import { isPathInside, resolveWorkspacePath } from "../src/filesystem/workspace.js";

describe("workspace path resolution", () => {
  it("resolves a relative path inside the workspace", () => {
    const workspaceRoot = path.resolve("tmp", "repo");
    const resolved = resolveWorkspacePath(
      {
        cwd: workspaceRoot,
        sessionId: "test",
        workspaceRoots: [workspaceRoot],
      },
      "src/index.ts",
    );

    expect(resolved.absolutePath).toBe(path.join(workspaceRoot, "src", "index.ts"));
    expect(resolved.relativePath).toBe("src/index.ts");
  });

  it("resolves an absolute path inside the workspace", () => {
    const workspaceRoot = path.resolve("tmp", "repo");
    const absolutePath = path.join(workspaceRoot, "src", "index.ts");
    const resolved = resolveWorkspacePath(
      {
        cwd: workspaceRoot,
        sessionId: "test",
        workspaceRoots: [workspaceRoot],
      },
      absolutePath,
    );

    expect(resolved.absolutePath).toBe(absolutePath);
    expect(resolved.relativePath).toBe("src/index.ts");
  });

  it("rejects traversal outside the workspace", () => {
    const workspaceRoot = path.resolve("tmp", "repo");

    expect(() =>
      resolveWorkspacePath(
        {
          cwd: workspaceRoot,
          sessionId: "test",
          workspaceRoots: [workspaceRoot],
        },
        "../outside.txt",
      ),
    ).toThrow("outside the configured workspace roots");
  });

  it("rejects sibling-prefix escapes", () => {
    const parent = path.resolve("tmp");
    const workspaceRoot = path.join(parent, "repo");
    const sibling = path.join(parent, "repo-other", "file.txt");

    expect(isPathInside(workspaceRoot, sibling)).toBe(false);
  });

  it("normalizes Windows-style separators in user paths", () => {
    const workspaceRoot = path.resolve("tmp", "repo");
    const resolved = resolveWorkspacePath(
      {
        cwd: workspaceRoot,
        sessionId: "test",
        workspaceRoots: [workspaceRoot],
      },
      "src\\nested\\file.ts",
    );

    expect(resolved.absolutePath).toBe(path.join(workspaceRoot, "src", "nested", "file.ts"));
    expect(resolved.relativePath).toBe("src/nested/file.ts");
  });
});
