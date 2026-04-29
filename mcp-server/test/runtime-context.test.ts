import path from "node:path";

import { createRuntimeContext } from "../src/runtime/context.js";

describe("createRuntimeContext", () => {
  it("uses process defaults when no environment override is set", () => {
    const context = createRuntimeContext({});

    expect(context.cwd).toBe(path.resolve(process.cwd()));
    expect(context.sessionId).toBe("default");
    expect(context.workspaceRoots).toEqual([path.resolve(process.cwd())]);
  });

  it("resolves cwd, session id, and workspace root overrides", () => {
    const firstRoot = path.join("tmp", "first");
    const secondRoot = path.join("tmp", "second");
    const context = createRuntimeContext({
      DIRAC_MCP_CWD: "tmp/workspace",
      DIRAC_MCP_SESSION_ID: "session-1",
      DIRAC_MCP_WORKSPACE_ROOTS: `${firstRoot}${path.delimiter}${secondRoot}`,
    });

    expect(context.cwd).toBe(path.resolve("tmp/workspace"));
    expect(context.sessionId).toBe("session-1");
    expect(context.workspaceRoots).toEqual([path.resolve(firstRoot), path.resolve(secondRoot)]);
  });
});
