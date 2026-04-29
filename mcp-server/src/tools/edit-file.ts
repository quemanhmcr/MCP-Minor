import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { editWorkspaceFile, formatEditFileResult } from "../filesystem/edit-file.js";
import { normalizeWorkspaceError } from "../filesystem/workspace.js";
import type { RuntimeContext } from "../runtime/context.js";
import { structuredToolResponse, toolErrorResponse } from "./response.js";

export const editFileInputSchema = {
  path: z.string().min(1).describe("Single file to edit, relative to the server cwd unless absolute."),
  edits: z
    .array(
      z.object({
        anchor: z.string().min(1).describe("Start-line anchor returned by a prior read_file call for this file."),
        oldText: z.string().describe("Exact current text to replace, starting at anchor. Multi-line text uses newline characters."),
        newText: z.string().describe("Replacement text. Multi-line text uses newline characters; empty string deletes oldText."),
      }),
    )
    .min(1)
    .describe("One or more non-overlapping anchored replacements within the single file."),
};

const appliedEditSchema = z.object({
  anchor: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  oldText: z.string(),
  newText: z.string(),
  linesRemoved: z.number().int().nonnegative(),
  linesAdded: z.number().int().nonnegative(),
});

export const editFileOutputSchema = {
  path: z.string(),
  relativePath: z.string(),
  changed: z.literal(true),
  editsApplied: z.number().int().positive(),
  fileHashBefore: z.string(),
  fileHashAfter: z.string(),
  lineEnding: z.enum(["lf", "crlf"]),
  appliedEdits: z.array(appliedEditSchema),
  diff: z.string(),
};

export function registerEditFileTool(server: McpServer, context: RuntimeContext): void {
  server.registerTool(
    "edit_file",
    {
      title: "Edit file",
      description:
        "Replace exact text in one workspace file using anchors returned by read_file. Applies all non-overlapping edits atomically after exact oldText validation.",
      inputSchema: editFileInputSchema,
      outputSchema: editFileOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    createEditFileHandler(context),
  );
}

export function createEditFileHandler(context: RuntimeContext) {
  return async (input: {
    path: string;
    edits: Array<{
      anchor: string;
      oldText: string;
      newText: string;
    }>;
  }) => {
    try {
      const result = await editWorkspaceFile(context, input);
      const response = structuredToolResponse(result as unknown as Record<string, unknown>);

      response.content[0].text = formatEditFileResult(result);
      return response;
    } catch (error) {
      return toolErrorResponse(error, normalizeWorkspaceError);
    }
  };
}
