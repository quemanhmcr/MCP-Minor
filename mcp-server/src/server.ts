import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { RuntimeContext } from "./runtime/context.js";
import { createListFilesHandler, listFilesInputSchema, listFilesOutputSchema } from "./tools/list-files.js";

export const SERVER_NAME = "dirac-codebase-tools";
export const SERVER_VERSION = "0.1.0";

export function createMcpServer(context: RuntimeContext): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "list_files",
    {
      title: "List files",
      description:
        "List files and directories within one or more workspace paths. Paths are resolved relative to the server cwd unless absolute, constrained to configured workspace roots, and generated directories are skipped.",
      inputSchema: listFilesInputSchema,
      outputSchema: listFilesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    createListFilesHandler(context),
  );

  return server;
}
