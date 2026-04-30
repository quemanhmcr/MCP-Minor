import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  MAX_LIST_FILES_LIMIT,
  compactListFilesResult,
  formatListFilesCompact,
  listWorkspaceFiles,
} from "../filesystem/list-files.js";
import { normalizeWorkspaceError } from "../filesystem/workspace.js";
import type { RuntimeContext } from "../runtime/context.js";
import { compactToolResponse, structuredToolResponse, toolErrorResponse, type ToolOutputFormat } from "./response.js";

type ListFilesView = "outline" | "full";

export const listFilesInputSchema = {
  paths: z.array(z.string().min(1)).min(1).describe("Paths to list, relative to the server cwd unless absolute."),
  recursive: z.boolean().optional().default(false).describe("Whether to list files and directories recursively."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Maximum number of entries to return. Values above ${MAX_LIST_FILES_LIMIT} are clamped.`),
  view: z.enum(["outline", "full"]).optional().describe("Output view. Defaults to compact outline text; use full for rich structured metadata."),
  format: z.enum(["compact", "json"]).optional().describe("Deprecated alias: compact maps to view=outline, json maps to view=full."),
};

export const listFilesOutputSchema = {
  entries: z.union(
    [
      z.array(
        z.object({
          path: z.string(),
          type: z.enum(["file", "directory"]),
          relativePath: z.string(),
        }),
      ),
      z.number().int().nonnegative(),
    ],
  ),
  view: z.literal("outline").optional(),
  limit: z.number().int().positive(),
  truncated: z.boolean(),
};

export function registerListFilesTool(server: McpServer, context: RuntimeContext): void {
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
}

export function createListFilesHandler(context: RuntimeContext) {
  return async (input: {
    paths: string[];
    recursive?: boolean;
    limit?: number;
    view?: ListFilesView;
    format?: ToolOutputFormat;
  }) => {
    try {
      const result = await listWorkspaceFiles(context, input);

      if (resolveListFilesView(input) === "outline") {
        return compactToolResponse(formatListFilesCompact(result), compactListFilesResult(result));
      }

      return structuredToolResponse(result as unknown as Record<string, unknown>);
    } catch (error) {
      return toolErrorResponse(error, normalizeWorkspaceError);
    }
  };
}

function resolveListFilesView(input: { view?: ListFilesView; format?: ToolOutputFormat }): ListFilesView {
  if (input.format === "json") {
    return "full";
  }

  if (input.view) {
    return input.view;
  }
  return "outline";
}
