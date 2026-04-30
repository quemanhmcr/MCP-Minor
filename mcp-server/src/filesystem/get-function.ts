import { promises as fs } from "node:fs";

import {
  formatReadFileResult,
  readWorkspaceFiles,
  type ReadFileResult,
} from "./read-file.js";
import {
  getWorkspaceFileSkeleton,
  type FileSkeletonEntry,
  type SkeletonEntry,
  type SkeletonEntryKind,
  type SourceLocation,
} from "./file-skeleton.js";
import { contentHash } from "../runtime/anchor-state.js";
import type { RuntimeContext } from "../runtime/context.js";

export const DEFAULT_GET_FUNCTION_CONTEXT_LINES = 1;
export const MAX_GET_FUNCTION_CONTEXT_LINES = 20;
export const DEFAULT_GET_FUNCTION_SOURCE_LINE_LIMIT = 160;
export const MAX_GET_FUNCTION_SOURCE_LINE_LIMIT = 500;
export const DEFAULT_GET_FUNCTION_SOURCE_CHARS = 30_000;
export const MAX_GET_FUNCTION_SOURCE_CHARS = 120_000;

const TARGET_KINDS = new Set<SkeletonEntryKind>(["function", "method"]);

export class GetFunctionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GetFunctionError";
  }
}

export interface GetFunctionInput {
  paths: string[];
  functionNames?: string[];
  function_names?: string[];
  contextLines?: number;
  sourceLineLimit?: number;
  maxSourceChars?: number;
}

export interface GetFunctionTarget {
  requestedName: string;
  name: string;
  qualifiedName: string;
  kind: "function" | "method";
  signature: string;
  signatureTruncated: boolean;
  location: SourceLocation;
  containsParseErrors: boolean;
  sourceHash: string;
  source: string;
  sourceStartLine: number;
  sourceEndLine: number;
  sourceLineCount: number;
  contextLinesBefore: number;
  contextLinesAfter: number;
  truncated: boolean;
  edit?: {
    content: string;
    structured: ReadFileResult;
  };
}

export interface GetFunctionFileResult {
  path: string;
  relativePath: string;
  language: FileSkeletonEntry["language"];
  sourceLineCount: number;
  hasParseErrors: boolean;
  matches: GetFunctionTarget[];
  missing: string[];
}

export interface GetFunctionResult {
  files: GetFunctionFileResult[];
  functionNames: string[];
  contextLines: number;
  sourceLineLimit: number;
  maxSourceChars: number;
  matchCount: number;
  missing: Array<{ relativePath: string; functionName: string }>;
  truncated: boolean;
}

export interface CompactGetFunctionResult {
  view: "source" | "edit";
  files: Array<{
    relativePath: string;
    language: FileSkeletonEntry["language"];
    hasParseErrors: boolean;
    matchCount: number;
    missing: string[];
  }>;
  matchCount: number;
  missingCount: number;
  truncated: boolean;
}

export async function getWorkspaceFunctions(
  context: RuntimeContext,
  input: GetFunctionInput,
  options: { includeEditAnchors?: boolean } = {},
): Promise<GetFunctionResult> {
  const paths = validatePaths(input.paths);
  const functionNames = validateFunctionNames(input.functionNames ?? input.function_names);
  const contextLines = validateBoundedInteger(
    input.contextLines,
    DEFAULT_GET_FUNCTION_CONTEXT_LINES,
    MAX_GET_FUNCTION_CONTEXT_LINES,
    "contextLines",
  );
  const sourceLineLimit = validateBoundedInteger(
    input.sourceLineLimit,
    DEFAULT_GET_FUNCTION_SOURCE_LINE_LIMIT,
    MAX_GET_FUNCTION_SOURCE_LINE_LIMIT,
    "sourceLineLimit",
  );
  const maxSourceChars = validateBoundedInteger(
    input.maxSourceChars,
    DEFAULT_GET_FUNCTION_SOURCE_CHARS,
    MAX_GET_FUNCTION_SOURCE_CHARS,
    "maxSourceChars",
  );

  const skeleton = await getWorkspaceFileSkeleton(context, { paths });
  const files: GetFunctionFileResult[] = [];

  for (const file of skeleton.files) {
    files.push(
      await extractFunctionsFromFile(context, file, functionNames, {
        contextLines,
        sourceLineLimit,
        maxSourceChars,
        includeEditAnchors: options.includeEditAnchors ?? false,
      }),
    );
  }

  const missing = files.flatMap((file) =>
    file.missing.map((functionName) => ({
      relativePath: file.relativePath,
      functionName,
    })),
  );
  const matchCount = files.reduce((count, file) => count + file.matches.length, 0);

  if (matchCount === 0) {
    throw new GetFunctionError(
      `None of the requested functions (${functionNames.join(", ")}) were found in ${paths.join(", ")}.`,
    );
  }

  return {
    files,
    functionNames,
    contextLines,
    sourceLineLimit,
    maxSourceChars,
    matchCount,
    missing,
    truncated: files.some((file) => file.matches.some((match) => match.truncated)),
  };
}

export function formatGetFunctionCompact(
  result: GetFunctionResult,
  options: { view?: "source" | "edit" } = {},
): string {
  const view = options.view ?? "source";
  const sections: string[] = [];

  for (const file of result.files) {
    for (const match of file.matches) {
      const header = [
        `${file.relativePath}::${match.qualifiedName}`,
        match.kind,
        formatLineRange(match.location),
        match.signature ? `sig:${trimInline(match.signature)}` : "",
        `hash:${match.sourceHash}`,
        match.containsParseErrors ? "parse:err" : "parse:ok",
        match.truncated ? "trunc" : "",
      ].filter(Boolean).join(" | ");
      sections.push(`${header}\n${view === "edit" && match.edit ? match.edit.content : match.source}`);
    }

    if (file.missing.length > 0) {
      sections.push(`${file.relativePath}::missing ${file.missing.join(", ")}`);
    }
  }

  return sections.join("\n\n---\n\n");
}

export function compactGetFunctionResult(
  result: GetFunctionResult,
  options: { view?: "source" | "edit" } = {},
): CompactGetFunctionResult {
  return {
    view: options.view ?? "source",
    files: result.files.map((file) => ({
      relativePath: file.relativePath,
      language: file.language,
      hasParseErrors: file.hasParseErrors,
      matchCount: file.matches.length,
      missing: file.missing,
    })),
    matchCount: result.matchCount,
    missingCount: result.missing.length,
    truncated: result.truncated,
  };
}

async function extractFunctionsFromFile(
  context: RuntimeContext,
  file: FileSkeletonEntry,
  functionNames: string[],
  options: {
    contextLines: number;
    sourceLineLimit: number;
    maxSourceChars: number;
    includeEditAnchors: boolean;
  },
): Promise<GetFunctionFileResult> {
  const source = await fs.readFile(file.path, "utf8");
  const lines = splitLines(source);
  const entries = flattenTargetEntries(file.entries);
  const matches: GetFunctionTarget[] = [];
  const missing: string[] = [];

  for (const requestedName of functionNames) {
    const candidates = entries.filter((entry) => matchesRequestedName(entry, requestedName));
    if (candidates.length === 0) {
      missing.push(requestedName);
      continue;
    }

    if (candidates.length > 1) {
      throw new GetFunctionError(
        `Function name '${requestedName}' is ambiguous in ${file.relativePath}. Matches: ${candidates
          .map((candidate) => candidate.qualifiedName)
          .join(", ")}.`,
      );
    }

    matches.push(
      await buildFunctionTarget(context, file, candidates[0], requestedName, lines, options),
    );
  }

  return {
    path: file.path,
    relativePath: file.relativePath,
    language: file.language,
    sourceLineCount: file.sourceLineCount,
    hasParseErrors: file.hasParseErrors,
    matches,
    missing,
  };
}

async function buildFunctionTarget(
  context: RuntimeContext,
  file: FileSkeletonEntry,
  entry: SkeletonEntry,
  requestedName: string,
  lines: string[],
  options: {
    contextLines: number;
    sourceLineLimit: number;
    maxSourceChars: number;
    includeEditAnchors: boolean;
  },
): Promise<GetFunctionTarget> {
  const sourceStartLine = Math.max(1, entry.location.startLine - options.contextLines);
  const sourceEndLine = Math.min(lines.length, entry.location.endLine + options.contextLines);
  const selected = capLinesAndChars(
    lines.slice(sourceStartLine - 1, sourceEndLine),
    sourceStartLine,
    options.sourceLineLimit,
    options.maxSourceChars,
  );
  const source = selected.lines.map((line, index) => `${(sourceStartLine + index).toString(36)}|${line}`).join("\n");
  const rawSource = selected.lines.join("\n");
  const edit = options.includeEditAnchors
    ? await readWorkspaceFiles(context, {
        paths: [file.path],
        startLine: sourceStartLine,
        endLine: sourceStartLine + selected.lines.length - 1,
        lineLimit: selected.lines.length,
        includeAnchors: true,
      })
    : undefined;

  return {
    requestedName,
    name: entry.name,
    qualifiedName: entry.qualifiedName,
    kind: entry.kind as "function" | "method",
    signature: entry.signature,
    signatureTruncated: entry.signatureTruncated,
    location: entry.location,
    containsParseErrors: entry.containsParseErrors,
    sourceHash: contentHash(rawSource),
    source: selected.truncated ? `${source}\n[get_function source truncated]` : source,
    sourceStartLine,
    sourceEndLine: sourceStartLine + selected.lines.length - 1,
    sourceLineCount: selected.lines.length,
    contextLinesBefore: entry.location.startLine - sourceStartLine,
    contextLinesAfter: Math.max(0, sourceStartLine + selected.lines.length - 1 - entry.location.endLine),
    truncated: selected.truncated,
    ...(edit
      ? {
          edit: {
            content: formatReadFileResult(edit, { includeAnchors: true }),
            structured: edit,
          },
        }
      : {}),
  };
}

function flattenTargetEntries(entries: SkeletonEntry[]): SkeletonEntry[] {
  return entries.flatMap((entry) => [
    ...(TARGET_KINDS.has(entry.kind) ? [entry] : []),
    ...flattenTargetEntries(entry.children),
  ]);
}

function matchesRequestedName(entry: SkeletonEntry, requestedName: string): boolean {
  const normalizedRequest = requestedName.replace(/::/gu, ".").trim();
  const normalizedQualifiedName = entry.qualifiedName.replace(/::/gu, ".");
  return normalizedQualifiedName === normalizedRequest || normalizedQualifiedName.endsWith(`.${normalizedRequest}`);
}

function capLinesAndChars(
  lines: string[],
  startLine: number,
  sourceLineLimit: number,
  maxSourceChars: number,
): { lines: string[]; truncated: boolean } {
  const cappedLines = lines.slice(0, sourceLineLimit);
  const selected: string[] = [];
  let remainingChars = maxSourceChars;
  let truncated = cappedLines.length < lines.length;

  for (const line of cappedLines) {
    const prefixLength = `${(startLine + selected.length).toString(36)}|`.length + 1;
    const lineBudget = remainingChars - prefixLength;
    if (lineBudget <= 0) {
      truncated = true;
      break;
    }

    if (line.length > lineBudget) {
      selected.push(line.slice(0, lineBudget));
      truncated = true;
      break;
    }

    selected.push(line);
    remainingChars -= prefixLength + line.length;
  }

  return {
    lines: selected,
    truncated,
  };
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const lines = text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function formatLineRange(location: SourceLocation): string {
  return location.startLine === location.endLine ? `L${location.startLine}` : `L${location.startLine}-${location.endLine}`;
}

function trimInline(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function validatePaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new GetFunctionError("paths must be a non-empty array of strings.");
  }

  return paths.map((userPath) => {
    if (typeof userPath !== "string" || !userPath.trim()) {
      throw new GetFunctionError("paths must contain only non-empty strings.");
    }
    return userPath;
  });
}

function validateFunctionNames(functionNames: unknown): string[] {
  if (!Array.isArray(functionNames) || functionNames.length === 0) {
    throw new GetFunctionError("functionNames must be a non-empty array of strings.");
  }

  return functionNames.map((functionName) => {
    if (typeof functionName !== "string" || !functionName.trim()) {
      throw new GetFunctionError("functionNames must contain only non-empty strings.");
    }
    return functionName;
  });
}

function validateBoundedInteger(
  value: number | undefined,
  defaultValue: number,
  maxValue: number,
  name: string,
): number {
  if (value === undefined) {
    return defaultValue;
  }

  const minimum = name === "contextLines" ? 0 : 1;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    throw new GetFunctionError(
      `${name} must be a ${minimum === 0 ? "non-negative" : "positive"} integer when provided.`,
    );
  }

  return Math.min(value, maxValue);
}
