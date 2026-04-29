import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { RuntimeContext } from "../runtime/context.js";
import { registerListFilesTool } from "./list-files.js";

export function registerTools(server: McpServer, context: RuntimeContext): void {
  registerListFilesTool(server, context);
}
