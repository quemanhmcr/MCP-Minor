import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  DEFAULT_FILE_SKELETON_LIMIT,
  DEFAULT_MAX_SIGNATURE_CHARS,
  MAX_SIGNATURE_CHARS,
  compactFileSkeletonResult,
  formatFileSkeletonCompact,
  getWorkspaceFileSkeleton,
  MAX_FILE_SKELETON_LIMIT,
} from "../filesystem/file-skeleton.js";
import { normalizeWorkspaceError } from "../filesystem/workspace.js";
import type { RuntimeContext } from "../runtime/context.js";
import { compactToolResponse, structuredToolResponse, toolErrorResponse, type ToolOutputFormat } from "./response.js";

type FileSkeletonView = "outline" | "signatures" | "full";

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
  view: z.enum(["outline", "signatures", "full"]).optional().describe("Output view. outline omits signatures; signatures includes compact signatures; full returns rich structured metadata."),
  includeImports: z.boolean().optional().default(true).describe("Include compact grouped import/export lines in outline or signatures views."),
  maxSignatureChars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Maximum signature chars in signatures view. Defaults to ${DEFAULT_MAX_SIGNATURE_CHARS}; values above ${MAX_SIGNATURE_CHARS} are clamped.`),
  format: z.enum(["compact", "json"]).optional().describe("Deprecated alias: compact maps to view=signatures, json maps to view=full."),
};

export const fileSkeletonOutputSchema = {
  files: z.array(
    z.object({
      path: z.string().optional(),
      relativePath: z.string(),
      language: z.enum(["javascript", "typescript", "tsx"]),
      rootType: z.string().optional(),
      sourceLength: z.number().int().nonnegative(),
      sourceLineCount: z.number().int().nonnegative(),
      locationEncoding: z.literal("tree-sitter-utf8-byte-offsets").optional(),
      hasParseErrors: z.boolean(),
      entries: z.array(skeletonEntrySchema).optional(),
      entryCount: z.number().int().nonnegative(),
      limit: z.number().int().positive().optional(),
      truncated: z.boolean(),
    }),
  ),
  view: z.enum(["outline", "signatures"]).optional(),
  limit: z.number().int().positive(),
  truncated: z.boolean(),
};

export function registerFileSkeletonTool(server: McpServer, context: RuntimeContext): void {
  server.registerTool(
    "get_file_skeleton",
    {
      title: "Get file skeleton",
      description:
        "Read the AST-backed structural outline of JavaScript and TypeScript files. Defaults to compact signatures text; use view: \"outline\" for cheaper navigation or view: \"full\" for ids, byte offsets, and nested metadata.",
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
  return async (input: {
    paths: string[];
    limit?: number;
    view?: FileSkeletonView;
    includeImports?: boolean;
    maxSignatureChars?: number;
    format?: ToolOutputFormat;
  }) => {
    try {
      const result = await getWorkspaceFileSkeleton(context, input);
      const view = resolveFileSkeletonView(input);

      if (view !== "full") {
        const options = {
          view,
          includeImports: input.includeImports,
          maxSignatureChars: input.maxSignatureChars,
        };
        return compactToolResponse(formatFileSkeletonCompact(result, options), compactFileSkeletonResult(result, options));
      }

      return structuredToolResponse(result as unknown as Record<string, unknown>);
    } catch (error) {
      return toolErrorResponse(error, normalizeWorkspaceError);
    }
  };
}

function resolveFileSkeletonView(input: { view?: FileSkeletonView; format?: ToolOutputFormat }): FileSkeletonView {
  if (input.format === "json") {
    return "full";
  }

  if (input.view) {
    return input.view;
  }
  return "signatures";
}
