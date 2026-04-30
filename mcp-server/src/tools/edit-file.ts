import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { editWorkspaceFile, formatEditFileResult } from "../filesystem/edit-file.js";
import { normalizeWorkspaceError } from "../filesystem/workspace.js";
import type { RuntimeContext } from "../runtime/context.js";
import { compactToolResponse, structuredToolResponse, toolErrorResponse, type ToolOutputFormat } from "./response.js";

type EditFileView = "summary" | "full";

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
  view: z.enum(["summary", "full"]).optional().describe("Output view. Defaults to compact edit summary; use full for applied edit metadata."),
  format: z.enum(["compact", "json"]).optional().describe("Deprecated alias: compact maps to view=summary, json maps to view=full."),
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
  view: z.literal("summary").optional(),
  path: z.string().optional(),
  relativePath: z.string(),
  changed: z.literal(true),
  editsApplied: z.number().int().positive(),
  fileHashBefore: z.string(),
  fileHashAfter: z.string(),
  lineEnding: z.enum(["lf", "crlf"]).optional(),
  appliedEdits: z.array(appliedEditSchema).optional(),
  diff: z.string().optional(),
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
    view?: EditFileView;
    format?: ToolOutputFormat;
  }) => {
    try {
      const result = await editWorkspaceFile(context, input);
      const view = resolveEditFileView(input);

      if (view === "summary") {
        return compactToolResponse(formatEditFileResult(result), {
          view: "summary",
          relativePath: result.relativePath,
          changed: result.changed,
          editsApplied: result.editsApplied,
          fileHashBefore: result.fileHashBefore,
          fileHashAfter: result.fileHashAfter,
        });
      }

      return structuredToolResponse(result as unknown as Record<string, unknown>);
    } catch (error) {
      return toolErrorResponse(error, normalizeWorkspaceError);
    }
  };
}

function resolveEditFileView(input: { view?: EditFileView; format?: ToolOutputFormat }): EditFileView {
  if (input.format === "json") {
    return "full";
  }

  if (input.view) {
    return input.view;
  }
  return "summary";
}
