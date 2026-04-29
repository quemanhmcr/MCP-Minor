import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  MAX_SEARCH_CONTEXT_LINES,
  MAX_SEARCH_FILES_LIMIT,
  searchWorkspaceFiles,
} from "../filesystem/search-files.js";
import { normalizeWorkspaceError } from "../filesystem/workspace.js";
import type { RuntimeContext } from "../runtime/context.js";
import { structuredToolResponse, toolErrorResponse } from "./response.js";

export const searchFilesInputSchema = {
  paths: z.array(z.string().min(1)).min(1).describe("Files or directories to search, relative to the server cwd unless absolute."),
  regex: z.string().min(1).describe("Rust regex pattern passed to ripgrep."),
  filePattern: z.string().min(1).optional().describe("Optional glob pattern for files, for example '*.ts'."),
  contextLines: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(`Context lines before and after each match. Values above ${MAX_SEARCH_CONTEXT_LINES} are clamped.`),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Maximum number of matches to return. Values above ${MAX_SEARCH_FILES_LIMIT} are clamped.`),
};

export const searchFilesOutputSchema = {
  matches: z.array(
    z.object({
      path: z.string(),
      relativePath: z.string(),
      line: z.number().int().positive(),
      column: z.number().int().positive().optional(),
      match: z.string(),
      preview: z
        .array(
          z.object({
            line: z.number().int().positive(),
            text: z.string(),
            match: z.boolean(),
          }),
        )
        .optional(),
    }),
  ),
  limit: z.number().int().positive(),
  truncated: z.boolean(),
};

export function registerSearchFilesTool(server: McpServer, context: RuntimeContext): void {
  server.registerTool(
    "search_files",
    {
      title: "Search files",
      description:
        "Regex search files within one or more workspace paths using ripgrep. Paths are constrained to configured workspace roots; generated directories are skipped.",
      inputSchema: searchFilesInputSchema,
      outputSchema: searchFilesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    createSearchFilesHandler(context),
  );
}

export function createSearchFilesHandler(context: RuntimeContext) {
  return async (input: {
    paths: string[];
    regex: string;
    filePattern?: string;
    contextLines?: number;
    limit?: number;
  }) => {
    try {
      const result = await searchWorkspaceFiles(context, input);

      return structuredToolResponse(result as unknown as Record<string, unknown>);
    } catch (error) {
      return toolErrorResponse(error, normalizeWorkspaceError);
    }
  };
}
