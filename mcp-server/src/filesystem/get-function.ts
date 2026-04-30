import { promises as fs, type Stats } from "node:fs";
import { StringDecoder } from "node:string_decoder";

import {
  formatReadFileResult,
  readWorkspaceFiles,
  type ReadFileResult,
} from "./read-file.js";
import {
  getWorkspaceFileSkeleton,
  type FileSkeletonEntry,
  MAX_FILE_SKELETON_BYTES,
  MAX_FILE_SKELETON_BYTES_LABEL,
  type SkeletonEntry,
  type SkeletonEntryKind,
  type SourceLocation,
} from "./file-skeleton.js";
import { isPathInside, type ResolvedWorkspacePath, resolveWorkspacePath } from "./workspace.js";
import { contentHash } from "../runtime/anchor-state.js";
import type { RuntimeContext } from "../runtime/context.js";

export const DEFAULT_GET_FUNCTION_CONTEXT_LINES = 0;
export const MAX_GET_FUNCTION_CONTEXT_LINES = 20;
export const DEFAULT_GET_FUNCTION_SOURCE_LINE_LIMIT = 160;
export const MAX_GET_FUNCTION_SOURCE_LINE_LIMIT = 500;
export const DEFAULT_GET_FUNCTION_SOURCE_CHARS = 30_000;
export const MAX_GET_FUNCTION_SOURCE_CHARS = 120_000;
export const MIN_GET_FUNCTION_SOURCE_CHARS = 64;
export const MAX_GET_FUNCTION_PATHS = 200;
export const MAX_GET_FUNCTION_NAMES = 200;
export const MAX_GET_FUNCTION_RESULT_ITEMS = 200;

const TARGET_KINDS = new Set<SkeletonEntryKind>(["function", "method"]);
const MAX_COMPACT_SIGNATURE_CHARS = 120;

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
  requireUnique?: boolean;
}

export type GetFunctionMatchType = "exact" | "suffix";
export type GetFunctionTruncatedBy = "lines" | "chars" | "lines+chars";

export interface GetFunctionTarget {
  requestedName: string;
  name: string;
  qualifiedName: string;
  kind: "function" | "method";
  signature: string;
  signatureTruncated: boolean;
  matchType: GetFunctionMatchType;
  location: SourceLocation;
  containsParseErrors: boolean;
  bodyHash: string;
  viewHash: string;
  source: string;
  sourceStartLine: number;
  sourceEndLine: number;
  sourceLineCount: number;
  contextLinesBefore: number;
  contextLinesAfter: number;
  truncated: boolean;
  truncatedBy?: GetFunctionTruncatedBy;
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
  ambiguous: Array<{
    requestedName: string;
    candidates: string[];
  }>;
}

export interface GetFunctionResult {
  files: GetFunctionFileResult[];
  functionNames: string[];
  contextLines: number;
  sourceLineLimit: number;
  maxSourceChars: number;
  matchCount: number;
  missing: Array<{ relativePath: string; functionName: string }>;
  ambiguous: Array<{ relativePath: string; requestedName: string; candidates: string[] }>;
  truncated: boolean;
}

export interface CompactGetFunctionResult {
  view: "source" | "edit";
  files: Array<{
    relativePath: string;
    language: FileSkeletonEntry["language"];
    hasParseErrors: boolean;
    matches: Array<{
      requestedName: string;
      name: string;
      qualifiedName: string;
      kind: "function" | "method";
      matchType: GetFunctionMatchType;
      startLine: number;
      endLine: number;
      truncated: boolean;
      truncatedBy?: GetFunctionTruncatedBy;
    }>;
    matchCount: number;
    missing: string[];
    ambiguous: Array<{ requestedName: string; candidates: string[] }>;
  }>;
  matchCount: number;
  missingCount: number;
  ambiguousCount: number;
  truncated: boolean;
}

export interface StructuredGetFunctionOptions {
  includeSource?: boolean;
  includeEdit?: boolean;
}

export async function getWorkspaceFunctions(
  context: RuntimeContext,
  input: GetFunctionInput,
  options: { includeEditAnchors?: boolean } = {},
): Promise<GetFunctionResult> {
  const paths = validatePaths(input.paths);
  const functionNames = validateFunctionNames(input.function_names, input.functionNames);
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
        requireUnique: input.requireUnique ?? false,
      }),
    );
  }

  const missing = files.flatMap((file) =>
    file.missing.map((functionName) => ({
      relativePath: file.relativePath,
      functionName,
    })),
  );
  const ambiguous = files.flatMap((file) =>
    file.ambiguous.map((entry) => ({
      relativePath: file.relativePath,
      requestedName: entry.requestedName,
      candidates: entry.candidates,
    })),
  );
  const matchCount = files.reduce((count, file) => count + file.matches.length, 0);
  validateResultItemCount(matchCount, missing.length, ambiguous.length);

  return {
    files,
    functionNames,
    contextLines,
    sourceLineLimit,
    maxSourceChars,
    matchCount,
    missing,
    ambiguous,
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
        match.matchType === "suffix" ? `req:${match.requestedName}` : "",
        match.signature ? `sig:${trimSignatureForHeader(match.signature)}` : "",
        view === "edit" ? `body:${match.bodyHash}` : "",
        view === "edit" ? `view:${match.viewHash}` : "",
        match.containsParseErrors ? "parse:err" : "",
        match.truncated ? `trunc${match.truncatedBy ? `:${match.truncatedBy}` : ""}` : "",
      ].filter(Boolean).join(" | ");
      sections.push(`${header}\n${view === "edit" && match.edit ? match.edit.content : match.source}`);
    }

    if (file.missing.length > 0) {
      sections.push(`${file.relativePath}::missing ${file.missing.join(", ")}`);
    }

    for (const ambiguous of file.ambiguous) {
      sections.push(`${file.relativePath}::ambiguous ${ambiguous.requestedName} -> ${ambiguous.candidates.join(", ")}`);
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
      matches: file.matches.map((match) => ({
        requestedName: match.requestedName,
        name: match.name,
        qualifiedName: match.qualifiedName,
        kind: match.kind,
        matchType: match.matchType,
        startLine: match.location.startLine,
        endLine: match.location.endLine,
        truncated: match.truncated,
        ...(match.truncatedBy ? { truncatedBy: match.truncatedBy } : {}),
      })),
      matchCount: file.matches.length,
      missing: file.missing,
      ambiguous: file.ambiguous,
    })),
    matchCount: result.matchCount,
    missingCount: result.missing.length,
    ambiguousCount: result.ambiguous.length,
    truncated: result.truncated,
  };
}

export function structuredGetFunctionResult(
  result: GetFunctionResult,
  options: StructuredGetFunctionOptions = {},
): Record<string, unknown> {
  return {
    ...result,
    files: result.files.map((file) => ({
      ...file,
      matches: file.matches.map((match) => {
        const { source, edit, ...metadata } = match;
        return {
          ...metadata,
          ...(options.includeSource ? { source } : {}),
          ...(options.includeEdit ? { edit } : {}),
        };
      }),
    })),
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
    requireUnique: boolean;
  },
): Promise<GetFunctionFileResult> {
  const source = await readValidatedSource(context, file.path);
  const lines = splitLines(source.text);
  const entries = collapseOverloadDeclarations(flattenTargetEntries(file.entries), source.text);
  const matches: GetFunctionTarget[] = [];
  const missing: string[] = [];
  const ambiguous: GetFunctionFileResult["ambiguous"] = [];

  for (const requestedName of functionNames) {
    const { candidates, matchType } = findCandidates(entries, requestedName);
    if (candidates.length === 0) {
      missing.push(requestedName);
      continue;
    }

    if (options.requireUnique && candidates.length > 1) {
      throw new GetFunctionError(
        `Function name '${requestedName}' is ambiguous in ${file.relativePath}. Matches: ${candidates
          .map((candidate) => candidate.qualifiedName)
          .join(", ")}.`,
      );
    }

    if (candidates.length > 1) {
      ambiguous.push({
        requestedName,
        candidates: candidates.map((candidate) => candidate.qualifiedName),
      });
    }

    for (const candidate of candidates) {
      matches.push(
        await buildFunctionTarget(context, file, candidate, requestedName, matchType, source.text, lines, options),
      );
    }
  }

  return {
    path: file.path,
    relativePath: file.relativePath,
    language: file.language,
    sourceLineCount: file.sourceLineCount,
    hasParseErrors: file.hasParseErrors,
    matches,
    missing,
    ambiguous,
  };
}

async function buildFunctionTarget(
  context: RuntimeContext,
  file: FileSkeletonEntry,
  entry: SkeletonEntry,
  requestedName: string,
  matchType: GetFunctionMatchType,
  rawText: string,
  lines: string[],
  options: {
    contextLines: number;
    sourceLineLimit: number;
    maxSourceChars: number;
    includeEditAnchors: boolean;
  },
): Promise<GetFunctionTarget> {
  const functionLocation = extendLocationToAttachedDecorators(entry.location, rawText, lines);
  const displayRange = getDisplayRange(functionLocation, lines.length, options.contextLines, options.sourceLineLimit);
  const sourceStartLine = displayRange.startLine;
  const sourceEndLine = displayRange.endLine;
  const selected = capLinesAndChars(
    lines.slice(sourceStartLine - 1, sourceEndLine),
    sourceStartLine,
    options.maxSourceChars,
  );
  const source = selected.lines.map((line, index) => `${(sourceStartLine + index).toString(36)}|${line}`).join("\n");
  const viewText = selected.lines.join("\n");
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
    matchType,
    location: functionLocation,
    containsParseErrors: entry.containsParseErrors,
    bodyHash: contentHash(Buffer.from(rawText, "utf8").subarray(functionLocation.startByte, functionLocation.endByte).toString("utf8")),
    viewHash: contentHash(viewText),
    source: selected.truncated ? `${source}\n[get_function source truncated]` : source,
    sourceStartLine,
    sourceEndLine: sourceStartLine + selected.lines.length - 1,
    sourceLineCount: selected.lines.length,
    contextLinesBefore: functionLocation.startLine - sourceStartLine,
    contextLinesAfter: Math.max(0, sourceStartLine + selected.lines.length - 1 - functionLocation.endLine),
    truncated: displayRange.truncated || selected.truncated,
    ...(combineTruncatedBy(displayRange.truncated ? "lines" : undefined, selected.truncated ? "chars" : undefined)
      ? { truncatedBy: combineTruncatedBy(displayRange.truncated ? "lines" : undefined, selected.truncated ? "chars" : undefined) }
      : {}),
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

function findCandidates(entries: SkeletonEntry[], requestedName: string): { candidates: SkeletonEntry[]; matchType: GetFunctionMatchType } {
  const normalizedRequest = normalizeLookupName(requestedName);
  const exact = entries.filter((entry) => normalizeLookupName(entry.qualifiedName) === normalizedRequest);
  if (exact.length > 0) {
    return { candidates: exact, matchType: "exact" };
  }

  return {
    candidates: entries.filter((entry) => normalizeLookupName(entry.qualifiedName).endsWith(`.${normalizedRequest}`)),
    matchType: "suffix",
  };
}

function normalizeLookupName(value: string): string {
  return value.replace(/::/gu, ".").trim().normalize("NFC");
}

function extendLocationToAttachedDecorators(
  location: SourceLocation,
  rawText: string,
  lines: string[],
): SourceLocation {
  let startLine = location.startLine;

  for (let index = location.startLine - 2; index >= 0; index--) {
    const line = lines[index]?.trim();
    if (!line) {
      break;
    }

    if (!line.startsWith("@")) {
      break;
    }

    startLine = index + 1;
  }

  if (startLine === location.startLine) {
    return location;
  }

  return {
    ...location,
    startLine,
    startByte: getByteOffsetForLine(rawText, startLine),
  };
}

function getByteOffsetForLine(rawText: string, lineNumber: number): number {
  if (lineNumber <= 1) {
    return 0;
  }

  let currentLine = 1;
  for (let index = 0; index < rawText.length; index++) {
    if (rawText[index] === "\n") {
      currentLine++;
      if (currentLine === lineNumber) {
        return Buffer.byteLength(rawText.slice(0, index + 1), "utf8");
      }
    }
  }

  return Buffer.byteLength(rawText, "utf8");
}

function collapseOverloadDeclarations(entries: SkeletonEntry[], source: string): SkeletonEntry[] {
  const grouped = new Map<string, SkeletonEntry[]>();
  for (const entry of entries) {
    const group = grouped.get(entry.qualifiedName);
    if (group) {
      group.push(entry);
    } else {
      grouped.set(entry.qualifiedName, [entry]);
    }
  }

  return Array.from(grouped.values()).flatMap((group) => {
    if (group.length <= 1) {
      return group;
    }

    const implementations = group.filter((entry) => hasImplementation(entry, source));
    return implementations.length > 0 ? implementations : group;
  });
}

function hasImplementation(entry: SkeletonEntry, source: string): boolean {
  const text = Buffer.from(source, "utf8").subarray(entry.location.startByte, entry.location.endByte).toString("utf8");
  return /\{|=>/u.test(text);
}

function getDisplayRange(
  location: SourceLocation,
  totalLines: number,
  contextLines: number,
  sourceLineLimit: number,
): { startLine: number; endLine: number; truncated: boolean } {
  const bodyLineCount = Math.max(0, location.endLine - location.startLine + 1);
  const selectedBodyLineCount = Math.min(bodyLineCount, sourceLineLimit);
  const bodyEndLine = location.startLine + selectedBodyLineCount - 1;
  const remaining = Math.max(0, sourceLineLimit - selectedBodyLineCount);
  const before = Math.min(contextLines, remaining, location.startLine - 1);
  const after = Math.min(contextLines, remaining - before, totalLines - bodyEndLine);

  return {
    startLine: Math.max(1, location.startLine - before),
    endLine: Math.min(totalLines, bodyEndLine + after),
    truncated: bodyLineCount > selectedBodyLineCount,
  };
}

function capLinesAndChars(
  lines: string[],
  startLine: number,
  maxSourceChars: number,
): { lines: string[]; truncated: boolean } {
  const selected: string[] = [];
  let remainingChars = maxSourceChars;
  let truncated = false;

  for (const line of lines) {
    const prefixLength = `${(startLine + selected.length).toString(36)}|`.length + 1;
    if (line.length + prefixLength > remainingChars) {
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

function combineTruncatedBy(
  lines: "lines" | undefined,
  chars: "chars" | undefined,
): GetFunctionTruncatedBy | undefined {
  if (lines && chars) {
    return "lines+chars";
  }
  return lines ?? chars;
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

function trimSignatureForHeader(value: string): string {
  const inline = trimInline(value);
  if (inline.length <= MAX_COMPACT_SIGNATURE_CHARS) {
    return inline;
  }

  return `${inline.slice(0, MAX_COMPACT_SIGNATURE_CHARS - 3).trimEnd()}...`;
}

function validatePaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new GetFunctionError("paths must be a non-empty array of strings.");
  }

  if (paths.length > MAX_GET_FUNCTION_PATHS) {
    throw new GetFunctionError(
      `get_function request has too many paths: ${paths.length} exceeds the limit of ${MAX_GET_FUNCTION_PATHS}.`,
    );
  }

  return paths.map((userPath) => {
    if (typeof userPath !== "string" || !userPath.trim()) {
      throw new GetFunctionError("paths must contain only non-empty strings.");
    }
    return userPath;
  });
}

function validateFunctionNames(function_names: unknown, functionNamesAlias: unknown): string[] {
  if (function_names !== undefined && functionNamesAlias !== undefined) {
    const canonical = JSON.stringify(function_names);
    const alias = JSON.stringify(functionNamesAlias);
    if (canonical !== alias) {
      throw new GetFunctionError("function_names and functionNames were both provided with different values.");
    }
  }

  const functionNames = function_names ?? functionNamesAlias;
  if (!Array.isArray(functionNames) || functionNames.length === 0) {
    throw new GetFunctionError("function_names must be a non-empty array of strings.");
  }

  if (functionNames.length > MAX_GET_FUNCTION_NAMES) {
    throw new GetFunctionError(
      `get_function request has too many function names: ${functionNames.length} exceeds the limit of ${MAX_GET_FUNCTION_NAMES}.`,
    );
  }

  return functionNames.map((functionName) => {
    if (typeof functionName !== "string" || !functionName.trim()) {
      throw new GetFunctionError("function_names must contain only non-empty strings.");
    }
    return functionName;
  });
}

function validateResultItemCount(matchCount: number, missingCount: number, ambiguousCount: number): void {
  const resultItems = matchCount + missingCount + ambiguousCount;
  if (resultItems > MAX_GET_FUNCTION_RESULT_ITEMS) {
    throw new GetFunctionError(
      `get_function result is too broad: ${resultItems} matches/missing/ambiguous items exceeds the limit of ${MAX_GET_FUNCTION_RESULT_ITEMS}. Narrow paths or function_names.`,
    );
  }
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

  const minimum = name === "contextLines" ? 0 : name === "maxSourceChars" ? MIN_GET_FUNCTION_SOURCE_CHARS : 1;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    throw new GetFunctionError(
      `${name} must be a ${minimum === 0 ? "non-negative" : "positive"} integer when provided.`,
    );
  }

  return Math.min(value, maxValue);
}

async function readValidatedSource(context: RuntimeContext, filePath: string): Promise<{ text: string; resolved: ResolvedWorkspacePath }> {
  const resolved = resolveWorkspacePath(context, filePath);
  const stat = await statPath(resolved);

  if (stat.isSymbolicLink()) {
    throw new GetFunctionError(`Path '${resolved.inputPath}' is a symbolic link and will not be followed.`);
  }

  if (!stat.isFile()) {
    throw new GetFunctionError(`Path '${resolved.inputPath}' is not a regular file.`);
  }

  await assertRealPathInsideWorkspace(resolved);

  if (stat.size > MAX_FILE_SKELETON_BYTES) {
    throw new GetFunctionError(
      `Path '${resolved.inputPath}' exceeds the ${MAX_FILE_SKELETON_BYTES_LABEL} get_function parse safety cap.`,
    );
  }

  const buffer = await fs.readFile(resolved.absolutePath);
  if (isBinaryLooking(buffer)) {
    throw new GetFunctionError(`Path '${resolved.inputPath}' appears to be binary or unsupported text.`);
  }

  const decoder = new StringDecoder("utf8");
  const text = decoder.write(buffer) + decoder.end();
  if (stat.size > 0 && text.includes("\uFFFD")) {
    throw new GetFunctionError(`Path '${resolved.inputPath}' is not valid UTF-8 text.`);
  }

  return { text, resolved };
}

async function statPath(resolved: ResolvedWorkspacePath): Promise<Stats> {
  try {
    return await fs.lstat(resolved.absolutePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new GetFunctionError(`Path '${resolved.inputPath}' does not exist.`);
    }

    throw new GetFunctionError(`Unable to inspect path '${resolved.inputPath}': ${getErrorMessage(error)}`);
  }
}

async function assertRealPathInsideWorkspace(resolved: ResolvedWorkspacePath): Promise<void> {
  let realPath: string;
  try {
    realPath = await fs.realpath(resolved.absolutePath);
  } catch (error) {
    throw new GetFunctionError(`Unable to resolve path '${resolved.inputPath}': ${getErrorMessage(error)}`);
  }

  if (!isPathInside(resolved.workspaceRoot, realPath)) {
    throw new GetFunctionError(`Path '${resolved.inputPath}' resolves outside the configured workspace roots.`);
  }
}

function isBinaryLooking(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) {
    return true;
  }

  let controlBytes = 0;
  for (const byte of sample) {
    const allowedControl = byte === 9 || byte === 10 || byte === 12 || byte === 13;
    if (byte < 32 && !allowedControl) {
      controlBytes++;
    }
  }

  return sample.length > 0 && controlBytes / sample.length > 0.05;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
