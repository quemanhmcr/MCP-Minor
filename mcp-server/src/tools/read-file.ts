import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  MAX_READ_FILE_LINE_LIMIT,
  compactReadFileResult,
  formatReadFileResult,
  readWorkspaceFiles,
} from "../filesystem/read-file.js";
import { normalizeWorkspaceError } from "../filesystem/workspace.js";
import type { RuntimeContext } from "../runtime/context.js";
import { compactToolResponse, structuredToolResponse, toolErrorResponse, type ToolOutputFormat } from "./response.js";

type ReadFileView = "read" | "edit" | "full";

export const readFileInputSchema = {
  paths: z.array(z.string().min(1)).min(1).describe("Files to read, relative to the server cwd unless absolute."),
  startLine: z.number().int().positive().optional().describe("Optional 1-based first line to read."),
  endLine: z.number().int().positive().optional().describe("Optional 1-based last line to read, inclusive."),
  start_line: z.number().int().positive().optional().describe("Dirac-compatible alias for startLine."),
  end_line: z.number().int().positive().optional().describe("Dirac-compatible alias for endLine."),
  lineLimit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Maximum number of lines per file to return. Values above ${MAX_READ_FILE_LINE_LIMIT} are clamped.`),
  view: z.enum(["read", "edit", "full"]).optional().describe("Output view. read is line-numbered without anchors; edit includes anchors and prepares edit_file; full returns per-line structured metadata."),
  includeAnchors: z.boolean().optional().describe("Override anchor inclusion. true makes compact output edit-ready."),
  format: z.enum(["compact", "json"]).optional().describe("Deprecated alias: compact maps to view=read, json maps to view=full."),
};

const readFileLineSchema = z.object({
  line: z.number().int().positive(),
  anchor: z.string(),
  text: z.string(),
  formatted: z.string(),
});

const editFileCompatibilitySchema = z.object({
  editable: z.boolean(),
  maxBytes: z.number().int().positive(),
  reason: z.string().optional(),
});

export const readFileOutputSchema = {
  files: z.array(
    z.object({
      path: z.string().optional(),
      relativePath: z.string(),
      fileHash: z.string().optional(),
      editFileCompatibility: editFileCompatibilitySchema.optional(),
      totalLines: z.number().int().nonnegative(),
      startLine: z.number().int().positive(),
      endLine: z.number().int().nonnegative(),
      editReady: z.boolean().optional(),
      lines: z.array(readFileLineSchema).optional(),
      content: z.string().optional(),
      truncated: z.boolean(),
      anchorDelimiter: z.string().optional(),
    }),
  ),
  view: z.enum(["read", "edit"]).optional(),
  lineLimit: z.number().int().positive(),
  truncated: z.boolean(),
};

export function registerReadFileTool(server: McpServer, context: RuntimeContext): void {
  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read one or more text/code files inside configured workspace roots. Returns line-numbered, hash-anchored text and structured per-line output. Full reads over 50KB require an explicit line range.",
      inputSchema: readFileInputSchema,
      outputSchema: readFileOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    createReadFileHandler(context),
  );
}

export function createReadFileHandler(context: RuntimeContext) {
  return async (input: {
    paths: string[];
    startLine?: number;
    endLine?: number;
    start_line?: number;
    end_line?: number;
    lineLimit?: number;
    view?: ReadFileView;
    includeAnchors?: boolean;
    format?: ToolOutputFormat;
  }) => {
    try {
      const view = resolveReadFileView(input);
      const includeAnchors = input.includeAnchors ?? (view === "edit" || view === "full");
      const result = await readWorkspaceFiles(context, { ...input, includeAnchors });

      if (view !== "full") {
        return compactToolResponse(
          formatReadFileResult(result, { includeAnchors }),
          compactReadFileResult(result, { includeAnchors }),
        );
      }

      return structuredToolResponse(result as unknown as Record<string, unknown>);
    } catch (error) {
      return toolErrorResponse(error, normalizeWorkspaceError);
    }
  };
}

function resolveReadFileView(input: { view?: ReadFileView; format?: ToolOutputFormat }): ReadFileView {
  if (input.format === "json") {
    return "full";
  }

  if (input.view) {
    return input.view;
  }
  return "read";
}
