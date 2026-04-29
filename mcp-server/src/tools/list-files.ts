import { z } from "zod";

import { MAX_LIST_FILES_LIMIT, listWorkspaceFiles } from "../filesystem/list-files.js";
import { normalizeWorkspaceError } from "../filesystem/workspace.js";
import type { RuntimeContext } from "../runtime/context.js";

export const listFilesInputSchema = {
  paths: z.array(z.string().min(1)).min(1).describe("Paths to list, relative to the server cwd unless absolute."),
  recursive: z.boolean().optional().default(false).describe("Whether to list files and directories recursively."),
  limit: z.number().int().positive().max(MAX_LIST_FILES_LIMIT).optional().describe("Maximum number of entries to return."),
};

export const listFilesOutputSchema = {
  entries: z.array(
    z.object({
      path: z.string(),
      type: z.enum(["file", "directory"]),
      relativePath: z.string(),
    }),
  ),
  limit: z.number().int().positive(),
  truncated: z.boolean(),
};

export function createListFilesHandler(context: RuntimeContext) {
  return async (input: {
    paths: string[];
    recursive?: boolean;
    limit?: number;
  }) => {
    try {
      const result = await listWorkspaceFiles(context, input);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (error) {
      const normalized = normalizeWorkspaceError(error);

      return {
        isError: true as const,
        content: [
          {
            type: "text" as const,
            text: normalized.message,
          },
        ],
      };
    }
  };
}
