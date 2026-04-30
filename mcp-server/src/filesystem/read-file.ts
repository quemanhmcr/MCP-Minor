import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { RuntimeContext } from "../runtime/context.js";
import {
  contentHash,
  formatLineWithAnchor,
  getAnchorDelimiter,
  reconcileAnchors,
} from "../runtime/anchor-state.js";
import { MAX_EDIT_FILE_BYTES, MAX_EDIT_FILE_BYTES_LABEL } from "./edit-file-limits.js";
import { isPathInside, type ResolvedWorkspacePath, resolveWorkspacePath } from "./workspace.js";

export const MAX_FULL_FILE_READ_BYTES = 50 * 1024;
export const MAX_READ_FILE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_READ_FILE_LINE_LIMIT = 2_000;
export const MAX_READ_FILE_LINE_LIMIT = 5_000;
export const MAX_READ_FILE_OUTPUT_CHARS = 400 * 1024;

const UNSUPPORTED_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".ico"]);

export class ReadFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadFileError";
  }
}

export interface ReadFileInput {
  paths: string[];
  startLine?: number;
  endLine?: number;
  start_line?: number;
  end_line?: number;
  lineLimit?: number;
  includeAnchors?: boolean;
}

export interface ReadFileLine {
  line: number;
  anchor: string;
  text: string;
  formatted: string;
}

export interface ReadFileEntry {
  path: string;
  relativePath: string;
  fileHash: string;
  editFileCompatibility: EditFileCompatibility;
  totalLines: number;
  startLine: number;
  endLine: number;
  lines: ReadFileLine[];
  content: string;
  truncated: boolean;
  anchorDelimiter: string;
}

export interface EditFileCompatibility {
  editable: boolean;
  maxBytes: number;
  reason?: string;
}

export interface ReadFileResult {
  files: ReadFileEntry[];
  lineLimit: number;
  truncated: boolean;
}

export interface CompactReadFileResult {
  view: "read" | "edit";
  files: Array<{
    relativePath: string;
    totalLines: number;
    startLine: number;
    endLine: number;
    truncated: boolean;
    editReady: boolean;
    editFileCompatibility?: EditFileCompatibility;
  }>;
  lineLimit: number;
  truncated: boolean;
}

interface LineRange {
  startLine?: number;
  endLine?: number;
}

interface OutputCapState {
  remainingChars: number;
  truncated: boolean;
}

export async function readWorkspaceFiles(context: RuntimeContext, input: ReadFileInput): Promise<ReadFileResult> {
  const paths = validatePaths(input.paths);
  const range = validateLineRange(input);
  const lineLimit = validateLineLimit(input.lineLimit);
  const outputCap: OutputCapState = {
    remainingChars: MAX_READ_FILE_OUTPUT_CHARS,
    truncated: false,
  };
  const files: ReadFileEntry[] = [];

  for (const userPath of paths) {
    if (outputCap.remainingChars <= 0) {
      outputCap.truncated = true;
      break;
    }

    files.push(await readOneFile(context, userPath, range, lineLimit, outputCap, input.includeAnchors ?? true));
  }

  return {
    files,
    lineLimit,
    truncated: outputCap.truncated || files.some((file) => file.truncated),
  };
}

export function formatReadFileResult(result: ReadFileResult, options: { includeAnchors?: boolean } = {}): string {
  return result.files
    .map((file) => {
      const header = options.includeAnchors
        ? `${file.relativePath} L${file.startLine}-${file.endLine}/${file.totalLines} edit`
        : `${file.relativePath} L${file.startLine}-${file.endLine}/${file.totalLines}`;
      const fileBreak = result.files.length > 1 ? `--- ${file.relativePath} ---\n` : "";
      const editFileWarning =
        file.editFileCompatibility.reason === undefined ? "" : `\nwarn: ${file.editFileCompatibility.reason}`;
      return `${fileBreak}${header}${editFileWarning}\n${file.content}`;
    })
    .join("\n\n");
}

export function compactReadFileResult(result: ReadFileResult, options: { includeAnchors?: boolean } = {}): CompactReadFileResult {
  return {
    view: options.includeAnchors ? "edit" : "read",
    files: result.files.map((file) => ({
      relativePath: file.relativePath,
      totalLines: file.totalLines,
      startLine: file.startLine,
      endLine: file.endLine,
      truncated: file.truncated,
      editReady: Boolean(options.includeAnchors),
      ...(file.editFileCompatibility.editable ? {} : { editFileCompatibility: file.editFileCompatibility }),
    })),
    lineLimit: result.lineLimit,
    truncated: result.truncated,
  };
}

export function formatReadLineNumber(lineNumber: number): string {
  return lineNumber.toString(36);
}

function validatePaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new ReadFileError("paths must be a non-empty array of strings.");
  }

  return paths.map((userPath) => {
    if (typeof userPath !== "string" || !userPath.trim()) {
      throw new ReadFileError("paths must contain only non-empty strings.");
    }

    return userPath;
  });
}

function validateLineRange(input: ReadFileInput): LineRange {
  const startLine = input.startLine ?? input.start_line;
  const endLine = input.endLine ?? input.end_line;

  if (startLine !== undefined && (!Number.isFinite(startLine) || !Number.isInteger(startLine) || startLine <= 0)) {
    throw new ReadFileError("startLine must be a positive integer when provided.");
  }

  if (endLine !== undefined && (!Number.isFinite(endLine) || !Number.isInteger(endLine) || endLine <= 0)) {
    throw new ReadFileError("endLine must be a positive integer when provided.");
  }

  if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
    throw new ReadFileError("startLine must be less than or equal to endLine.");
  }

  return {
    startLine,
    endLine,
  };
}

function validateLineLimit(lineLimit: number | undefined): number {
  if (lineLimit === undefined) {
    return DEFAULT_READ_FILE_LINE_LIMIT;
  }

  if (!Number.isFinite(lineLimit) || !Number.isInteger(lineLimit) || lineLimit <= 0) {
    throw new ReadFileError("lineLimit must be a positive integer when provided.");
  }

  return Math.min(lineLimit, MAX_READ_FILE_LINE_LIMIT);
}

async function readOneFile(
  context: RuntimeContext,
  userPath: string,
  range: LineRange,
  lineLimit: number,
  outputCap: OutputCapState,
  includeAnchors: boolean,
): Promise<ReadFileEntry> {
  const resolved = resolveWorkspacePath(context, userPath);
  const stat = await statPath(resolved);

  if (stat.isSymbolicLink()) {
    throw new ReadFileError(`Path '${resolved.inputPath}' is a symbolic link and will not be followed.`);
  }

  if (!stat.isFile()) {
    if (stat.isDirectory()) {
      throw new ReadFileError(`Path '${resolved.inputPath}' is a directory, not a file.`);
    }

    throw new ReadFileError(`Path '${resolved.inputPath}' is not a regular file.`);
  }

  await assertRealPathInsideWorkspace(resolved);
  assertSupportedFile(resolved);
  assertReadableSize(resolved, stat, range);

  const text = await readTextFile(resolved, stat);
  const allLines = splitLines(text);
  const fileHash = contentHash(text);
  const editFileCompatibility = getEditFileCompatibility(stat);
  const reconciledAnchors = reconcileAnchors(context.sessionId, resolved.absolutePath, allLines, fileHash, {
    editReady: includeAnchors,
  });
  const allAnchors = includeAnchors ? reconciledAnchors : allLines.map(() => "");
  const startLine = range.startLine ?? 1;
  const requestedEndLine = range.endLine ?? allLines.length;
  const boundedStartIndex = Math.min(startLine - 1, allLines.length);
  const boundedEndIndex = Math.min(requestedEndLine, allLines.length);
  const lineCount = Math.max(0, boundedEndIndex - boundedStartIndex);
  const cappedLineCount = Math.min(lineCount, lineLimit);
  const selectedLines = allLines.slice(boundedStartIndex, boundedStartIndex + cappedLineCount);
  const selectedAnchors = allAnchors.slice(boundedStartIndex, boundedStartIndex + cappedLineCount);
  const lines = selectedLines.map((line, index) => {
    const anchor = selectedAnchors[index];
    const lineNumber = boundedStartIndex + index + 1;
    return {
      line: lineNumber,
      anchor,
      text: line,
      formatted: includeAnchors ? formatLineWithAnchor(line, anchor) : formatReadLineForOutput(lineNumber, line),
    };
  });
  const cappedByLineLimit = cappedLineCount < lineCount;
  const content = capContent(lines.map((line) => line.formatted).join("\n"), outputCap);

  return {
    path: resolved.absolutePath,
    relativePath: resolved.relativePath,
    fileHash,
    editFileCompatibility,
    totalLines: allLines.length,
    startLine,
    endLine: lines.length === 0 ? Math.min(requestedEndLine, allLines.length) : lines[lines.length - 1].line,
    lines,
    content,
    truncated: cappedByLineLimit || outputCap.truncated,
    anchorDelimiter: getAnchorDelimiter(),
  };
}

function formatReadLineForOutput(lineNumber: number, line: string): string {
  return line.length === 0 ? "" : `${formatReadLineNumber(lineNumber)}|${line}`;
}

function getEditFileCompatibility(stat: Stats): EditFileCompatibility {
  if (stat.size <= MAX_EDIT_FILE_BYTES) {
    return {
      editable: true,
      maxBytes: MAX_EDIT_FILE_BYTES,
    };
  }

  return {
    editable: false,
    maxBytes: MAX_EDIT_FILE_BYTES,
    reason: `This file exceeds the ${MAX_EDIT_FILE_BYTES_LABEL} edit mutation cap. read_file can inspect it with line ranges, but edit_file cannot mutate it.`,
  };
}

async function statPath(resolved: ResolvedWorkspacePath): Promise<Stats> {
  try {
    return await fs.lstat(resolved.absolutePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new ReadFileError(`Path '${resolved.inputPath}' does not exist.`);
    }

    throw new ReadFileError(`Unable to inspect path '${resolved.inputPath}': ${getErrorMessage(error)}`);
  }
}

async function assertRealPathInsideWorkspace(resolved: ResolvedWorkspacePath): Promise<void> {
  let realPath: string;
  try {
    realPath = await fs.realpath(resolved.absolutePath);
  } catch (error) {
    throw new ReadFileError(`Unable to resolve path '${resolved.inputPath}': ${getErrorMessage(error)}`);
  }

  if (!isPathInside(resolved.workspaceRoot, realPath)) {
    throw new ReadFileError(`Path '${resolved.inputPath}' resolves outside the configured workspace roots.`);
  }
}

function assertSupportedFile(resolved: ResolvedWorkspacePath): void {
  const extension = path.extname(resolved.absolutePath).toLowerCase();
  if (UNSUPPORTED_EXTENSIONS.has(extension)) {
    throw new ReadFileError(
      `Path '${resolved.inputPath}' has unsupported file type '${extension}'. This MCP port currently supports text/code files only.`,
    );
  }
}

function assertReadableSize(resolved: ResolvedWorkspacePath, stat: Stats, range: LineRange): void {
  if (stat.size > MAX_READ_FILE_BYTES) {
    throw new ReadFileError(`Path '${resolved.inputPath}' is too large to read safely.`);
  }

  if (range.startLine === undefined && range.endLine === undefined && stat.size > MAX_FULL_FILE_READ_BYTES) {
    throw new ReadFileError(
      `Path '${resolved.inputPath}' is ${Math.round(stat.size / 1024)}KB, which exceeds the ${MAX_FULL_FILE_READ_BYTES / 1024}KB limit for full file reads. Specify startLine and endLine for a targeted read.`,
    );
  }
}

async function readTextFile(resolved: ResolvedWorkspacePath, stat: Stats): Promise<string> {
  const buffer = await fs.readFile(resolved.absolutePath);

  if (isBinaryLooking(buffer)) {
    throw new ReadFileError(`Path '${resolved.inputPath}' appears to be binary or unsupported text.`);
  }

  const decoder = new StringDecoder("utf8");
  const text = decoder.write(buffer) + decoder.end();

  if (stat.size > 0 && text.includes("\uFFFD")) {
    throw new ReadFileError(`Path '${resolved.inputPath}' is not valid UTF-8 text.`);
  }

  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
}

function capContent(content: string, outputCap: OutputCapState): string {
  if (content.length <= outputCap.remainingChars) {
    outputCap.remainingChars -= content.length;
    return content;
  }

  outputCap.truncated = true;
  const capped = content.slice(0, Math.max(0, outputCap.remainingChars));
  outputCap.remainingChars = 0;
  return `${capped}\n[read_file output truncated]`;
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
