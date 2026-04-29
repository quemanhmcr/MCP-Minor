import { SERVER_NAME, SERVER_VERSION, createMcpServer } from "../src/server.js";

describe("createMcpServer", () => {
  it("creates the MCP server without registering Dirac tools yet", () => {
    const server = createMcpServer({
      cwd: process.cwd(),
      sessionId: "test",
      workspaceRoots: [process.cwd()],
    });

    expect(server).toBeDefined();
    expect(SERVER_NAME).toBe("dirac-codebase-tools");
    expect(SERVER_VERSION).toBe("0.1.0");
  });
});
