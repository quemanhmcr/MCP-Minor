import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  MAX_READ_FILE_LINE_LIMIT,
  formatReadFileResult,
  readWorkspaceFiles,
} from "../filesystem/read-file.js";
import { normalizeWorkspaceError } from "../filesystem/workspace.js";
import type { RuntimeContext } from "../runtime/context.js";
import { structuredToolResponse, toolErrorResponse } from "./response.js";

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
};

const readFileLineSchema = z.object({
  line: z.number().int().positive(),
  anchor: z.string(),
  text: z.string(),
  formatted: z.string(),
});

export const readFileOutputSchema = {
  files: z.array(
    z.object({
      path: z.string(),
      relativePath: z.string(),
      fileHash: z.string(),
      totalLines: z.number().int().nonnegative(),
      startLine: z.number().int().positive(),
      endLine: z.number().int().nonnegative(),
      lines: z.array(readFileLineSchema),
      content: z.string(),
      truncated: z.boolean(),
      anchorDelimiter: z.string(),
    }),
  ),
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
  }) => {
    try {
      const result = await readWorkspaceFiles(context, input);
      const response = structuredToolResponse(result as unknown as Record<string, unknown>);

      response.content[0].text = formatReadFileResult(result);
      return response;
    } catch (error) {
      return toolErrorResponse(error, normalizeWorkspaceError);
    }
  };
}
