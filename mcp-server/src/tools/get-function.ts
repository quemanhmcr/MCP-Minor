import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  DEFAULT_GET_FUNCTION_CONTEXT_LINES,
  DEFAULT_GET_FUNCTION_SOURCE_CHARS,
  DEFAULT_GET_FUNCTION_SOURCE_LINE_LIMIT,
  MAX_GET_FUNCTION_CONTEXT_LINES,
  MAX_GET_FUNCTION_LOOKUPS,
  MAX_GET_FUNCTION_SOURCE_CHARS,
  MAX_GET_FUNCTION_SOURCE_LINE_LIMIT,
  MIN_GET_FUNCTION_SOURCE_CHARS,
  compactGetFunctionResult,
  formatGetFunctionCompact,
  getWorkspaceFunctions,
  structuredGetFunctionResult,
} from "../filesystem/get-function.js";
import { normalizeWorkspaceError } from "../filesystem/workspace.js";
import type { RuntimeContext } from "../runtime/context.js";
import { compactToolResponse, structuredToolResponse, toolErrorResponse, type ToolOutputFormat } from "./response.js";

type GetFunctionView = "source" | "edit" | "full";

const sourceLocationSchema = z.object({
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  startByte: z.number().int().nonnegative(),
  endByte: z.number().int().nonnegative(),
});

const getFunctionTargetSchema = z.object({
  requestedName: z.string(),
  name: z.string(),
  qualifiedName: z.string(),
  kind: z.enum(["function", "method"]),
  signature: z.string(),
  signatureTruncated: z.boolean(),
  matchType: z.enum(["exact", "suffix"]),
  location: sourceLocationSchema,
  containsParseErrors: z.boolean(),
  bodyHash: z.string(),
  viewHash: z.string(),
  source: z.string().optional(),
  sourceStartLine: z.number().int().positive(),
  sourceEndLine: z.number().int().positive(),
  sourceLineCount: z.number().int().nonnegative(),
  contextLinesBefore: z.number().int().nonnegative(),
  contextLinesAfter: z.number().int().nonnegative(),
  truncated: z.boolean(),
  truncatedBy: z.enum(["lines", "chars", "lines+chars"]).optional(),
  edit: z
    .object({
      content: z.string(),
      structured: z.unknown(),
    })
    .optional(),
});

export const getFunctionInputSchema = {
  paths: z.array(z.string().min(1)).min(1).describe("JavaScript or TypeScript source files to inspect."),
  function_names: z
    .array(z.string().min(1))
    .min(1)
    .describe(`Exact or suffix-qualified function names, such as buildName or Worker.run. paths.length * function_names.length must be <= ${MAX_GET_FUNCTION_LOOKUPS}.`),
  contextLines: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      `Context lines before and after the function. Defaults to ${DEFAULT_GET_FUNCTION_CONTEXT_LINES}; values above ${MAX_GET_FUNCTION_CONTEXT_LINES} are clamped.`,
    ),
  sourceLineLimit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Maximum source/context lines per returned function. Defaults to ${DEFAULT_GET_FUNCTION_SOURCE_LINE_LIMIT}; values above ${MAX_GET_FUNCTION_SOURCE_LINE_LIMIT} are clamped.`,
    ),
  maxSourceChars: z
    .number()
    .int()
    .min(MIN_GET_FUNCTION_SOURCE_CHARS)
    .optional()
    .describe(
      `Maximum source/context characters per returned function. Defaults to ${DEFAULT_GET_FUNCTION_SOURCE_CHARS}; minimum ${MIN_GET_FUNCTION_SOURCE_CHARS}; values above ${MAX_GET_FUNCTION_SOURCE_CHARS} are clamped.`,
    ),
  view: z.enum(["source", "edit", "full"]).optional().describe("Output view. source is compact bounded source; edit adds edit-ready anchors; full returns rich structured metadata."),
  requireUnique: z.boolean().optional().describe("When true, suffix matches that resolve to multiple candidates are returned as an error instead of all candidates."),
  includeSourceInStructured: z.boolean().optional().describe("Only applies to view=full. Includes bounded source text in structuredContent when true; omitted by default to avoid duplicating MCP text payloads."),
  format: z.enum(["compact", "json"]).optional().describe("Deprecated alias: compact maps to view=source, json maps to view=full."),
};

export const getFunctionOutputSchema = {
  files: z.array(
    z.object({
      path: z.string().optional(),
      relativePath: z.string(),
      language: z.enum(["javascript", "typescript", "tsx"]),
      sourceLineCount: z.number().int().nonnegative().optional(),
      hasParseErrors: z.boolean(),
      matches: z.array(getFunctionTargetSchema).optional(),
      matchCount: z.number().int().nonnegative().optional(),
      missing: z.array(z.string()),
      ambiguous: z.array(z.object({ requestedName: z.string(), candidates: z.array(z.string()) })).optional(),
    }),
  ),
  view: z.enum(["source", "edit"]).optional(),
  functionNames: z.array(z.string()).optional(),
  contextLines: z.number().int().nonnegative().optional(),
  sourceLineLimit: z.number().int().positive().optional(),
  maxSourceChars: z.number().int().positive().optional(),
  matchCount: z.number().int().nonnegative(),
  missingCount: z.number().int().nonnegative().optional(),
  ambiguousCount: z.number().int().nonnegative().optional(),
  missing: z.array(z.object({ relativePath: z.string(), functionName: z.string() })).optional(),
  ambiguous: z.array(z.object({ relativePath: z.string(), requestedName: z.string(), candidates: z.array(z.string()) })).optional(),
  truncated: z.boolean(),
};

export function registerGetFunctionTool(server: McpServer, context: RuntimeContext): void {
  server.registerTool(
    "get_function",
    {
      title: "Get function",
      description:
        "Extract targeted JavaScript or TypeScript function/method implementations from source files. Matches exact qualified names first, then suffix names; ambiguous suffix matches return all candidates unless requireUnique is true. Defaults to compact bounded source; use view: \"full\" for structured metadata or view: \"edit\" for edit-ready anchors.",
      inputSchema: getFunctionInputSchema,
      outputSchema: getFunctionOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    createGetFunctionHandler(context),
  );
}

export function createGetFunctionHandler(context: RuntimeContext) {
  return async (input: {
    paths: string[];
    functionNames?: string[];
    function_names?: string[];
    contextLines?: number;
    sourceLineLimit?: number;
    maxSourceChars?: number;
    requireUnique?: boolean;
    includeSourceInStructured?: boolean;
    view?: GetFunctionView;
    format?: ToolOutputFormat;
  }) => {
    try {
      const view = resolveGetFunctionView(input);
      const result = await getWorkspaceFunctions(context, input, { includeEditAnchors: view === "edit" });

      if (view !== "full") {
        const options = { view };
        return compactToolResponse(formatGetFunctionCompact(result, options), compactGetFunctionResult(result, options));
      }

      return structuredToolResponse(structuredGetFunctionResult(result, { includeSource: input.includeSourceInStructured }));
    } catch (error) {
      return toolErrorResponse(error, normalizeWorkspaceError);
    }
  };
}

function resolveGetFunctionView(input: { view?: GetFunctionView; format?: ToolOutputFormat }): GetFunctionView {
  if (input.format === "json") {
    return "full";
  }

  if (input.view) {
    return input.view;
  }
  return "source";
}
