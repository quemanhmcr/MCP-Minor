import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { RuntimeContext } from "./runtime/context.js";

export const SERVER_NAME = "dirac-codebase-tools";
export const SERVER_VERSION = "0.1.0";

export function createMcpServer(context: RuntimeContext): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  void context;

  return server;
}
