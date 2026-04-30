import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  MAX_SEARCH_CONTEXT_LINES,
  MAX_SEARCH_FILES_LIMIT,
  compactSearchFilesResult,
  formatSearchFilesCompact,
  searchWorkspaceFiles,
} from "../filesystem/search-files.js";
import { normalizeWorkspaceError } from "../filesystem/workspace.js";
import type { RuntimeContext } from "../runtime/context.js";
import { compactToolResponse, structuredToolResponse, toolErrorResponse, type ToolOutputFormat } from "./response.js";

type SearchFilesView = "matches" | "files" | "full";

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
  view: z.enum(["matches", "files", "full"]).optional().describe("Output view. Defaults to one compact line per match; files groups matches by file; full returns rich structured metadata."),
  includeColumn: z.boolean().optional().default(false).describe("Include ripgrep byte column in compact match lines."),
  format: z.enum(["compact", "json"]).optional().describe("Deprecated alias: compact maps to view=matches, json maps to view=full."),
};

export const searchFilesOutputSchema = {
  matches: z.union(
    [
      z.array(
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
      z.number().int().nonnegative(),
    ],
  ),
  view: z.enum(["matches", "files"]).optional(),
  files: z.number().int().nonnegative().optional(),
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
    view?: SearchFilesView;
    includeColumn?: boolean;
    format?: ToolOutputFormat;
  }) => {
    try {
      const result = await searchWorkspaceFiles(context, input);
      const view = resolveSearchFilesView(input);

      if (view !== "full") {
        return compactToolResponse(
          formatSearchFilesCompact(result, { view, includeColumn: Boolean(input.includeColumn) }),
          compactSearchFilesResult(result, { view }),
        );
      }

      return structuredToolResponse(result as unknown as Record<string, unknown>);
    } catch (error) {
      return toolErrorResponse(error, normalizeWorkspaceError);
    }
  };
}

function resolveSearchFilesView(input: { view?: SearchFilesView; format?: ToolOutputFormat }): SearchFilesView {
  if (input.format === "json") {
    return "full";
  }

  if (input.view) {
    return input.view;
  }
  return "matches";
}
