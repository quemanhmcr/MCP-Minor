import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  DEFAULT_FILE_SKELETON_LIMIT,
  formatFileSkeletonResult,
  getWorkspaceFileSkeleton,
  MAX_FILE_SKELETON_LIMIT,
} from "../filesystem/file-skeleton.js";
import { normalizeWorkspaceError } from "../filesystem/workspace.js";
import type { RuntimeContext } from "../runtime/context.js";
import { structuredToolResponse, toolErrorResponse } from "./response.js";

const sourceLocationSchema = z.object({
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  startByte: z.number().int().nonnegative(),
  endByte: z.number().int().nonnegative(),
});

const skeletonEntrySchema: z.ZodType<unknown> = z.object({
  id: z.string(),
  kind: z.enum(["class", "enum", "export", "function", "import", "interface", "method", "module", "type"]),
  name: z.string(),
  qualifiedName: z.string(),
  signature: z.string(),
  signatureTruncated: z.boolean(),
  location: sourceLocationSchema,
  containsParseErrors: z.boolean(),
  children: z.array(z.lazy(() => skeletonEntrySchema)),
});

export const fileSkeletonInputSchema = {
  paths: z.array(z.string().min(1)).min(1).describe("JavaScript or TypeScript source files to summarize."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Maximum skeleton entries per file. Defaults to ${DEFAULT_FILE_SKELETON_LIMIT}; values above ${MAX_FILE_SKELETON_LIMIT} are clamped.`,
    ),
};

export const fileSkeletonOutputSchema = {
  files: z.array(
    z.object({
      path: z.string(),
      relativePath: z.string(),
      language: z.enum(["javascript", "typescript", "tsx"]),
      rootType: z.string(),
      sourceLength: z.number().int().nonnegative(),
      locationEncoding: z.literal("tree-sitter-utf8-byte-offsets"),
      hasParseErrors: z.boolean(),
      entries: z.array(skeletonEntrySchema),
      entryCount: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      truncated: z.boolean(),
    }),
  ),
  limit: z.number().int().positive(),
  truncated: z.boolean(),
};

export function registerFileSkeletonTool(server: McpServer, context: RuntimeContext): void {
  server.registerTool(
    "get_file_skeleton",
    {
      title: "Get file skeleton",
      description:
        "Read the AST-backed structural outline of JavaScript and TypeScript files. Returns imports, exports, definitions, nested members, locations, parser metadata, and truncation status as structured JSON.",
      inputSchema: fileSkeletonInputSchema,
      outputSchema: fileSkeletonOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    createFileSkeletonHandler(context),
  );
}

export function createFileSkeletonHandler(context: RuntimeContext) {
  return async (input: { paths: string[]; limit?: number }) => {
    try {
      const result = await getWorkspaceFileSkeleton(context, input);
      const response = structuredToolResponse(result as unknown as Record<string, unknown>);

      response.content[0].text = formatFileSkeletonResult(result);
      return response;
    } catch (error) {
      return toolErrorResponse(error, normalizeWorkspaceError);
    }
  };
}
