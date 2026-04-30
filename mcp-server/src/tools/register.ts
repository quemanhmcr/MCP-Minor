import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { RuntimeContext } from "../runtime/context.js";
import { registerEditFileTool } from "./edit-file.js";
import { registerFileSkeletonTool } from "./file-skeleton.js";
import { registerGetFunctionTool } from "./get-function.js";
import { registerListFilesTool } from "./list-files.js";
import { registerReadFileTool } from "./read-file.js";
import { registerSearchFilesTool } from "./search-files.js";

export function registerTools(server: McpServer, context: RuntimeContext): void {
  registerListFilesTool(server, context);
  registerReadFileTool(server, context);
  registerSearchFilesTool(server, context);
  registerEditFileTool(server, context);
  registerFileSkeletonTool(server, context);
  registerGetFunctionTool(server, context);
}
