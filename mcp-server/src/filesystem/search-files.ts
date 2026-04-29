import { spawn } from "node:child_process";
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";

import type { RuntimeContext } from "../runtime/context.js";
import { isPathInside, type ResolvedWorkspacePath, resolveWorkspacePath, toStableRelativePath } from "./workspace.js";

export const DEFAULT_SEARCH_FILES_LIMIT = 100;
export const MAX_SEARCH_FILES_LIMIT = 1_000;
export const MAX_SEARCH_CONTEXT_LINES = 10;
export const MAX_RIPGREP_STDOUT_BYTES = 4 * 1024 * 1024;

const IGNORED_DIRECTORY_NAMES = new Set(["node_modules", "dist", "coverage", ".git"]);
const MAX_RIPGREP_STDERR_BYTES = 64 * 1024;
const DEFAULT_RIPGREP_COMMAND = "rg";

export class SearchFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchFilesError";
  }
}

export interface SearchFilesInput {
  paths: string[];
  regex: string;
  filePattern?: string;
  contextLines?: number;
  limit?: number;
}

export interface SearchFilesContextLine {
  line: number;
  text: string;
  match: boolean;
}

export interface SearchFilesEntry {
  path: string;
  relativePath: string;
  line: number;
  column?: number;
  match: string;
  preview?: SearchFilesContextLine[];
}

export interface SearchFilesResult {
  matches: SearchFilesEntry[];
  limit: number;
  truncated: boolean;
}

export interface SearchFilesOptions {
  rgCommand?: string;
}

interface RipgrepResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  stdoutTruncated: boolean;
}

interface ParsedLine {
  line: number;
  text: string;
  match: boolean;
}

interface ParsedMatch {
  absolutePath: string;
  line: number;
  column?: number;
  match: string;
}

interface ParsedFileResult {
  lines: Map<number, ParsedLine>;
  matches: ParsedMatch[];
}

type RipgrepMessage = {
  type?: string;
  data?: {
    path?: {
      text?: string;
    };
    line_number?: number;
    lines?: {
      text?: string;
    };
    submatches?: Array<{
      start?: number;
      match?: {
        text?: string;
      };
    }>;
  };
};

export async function searchWorkspaceFiles(
  context: RuntimeContext,
  input: SearchFilesInput,
  options: SearchFilesOptions = {},
): Promise<SearchFilesResult> {
  const paths = validatePaths(input.paths);
  const regex = validateRegex(input.regex);
  const filePattern = validateFilePattern(input.filePattern);
  const contextLines = validateContextLines(input.contextLines);
  const limit = validateLimit(input.limit);
  const resolvedPaths = await resolveSearchPaths(context, paths);

  if (resolvedPaths.length === 0) {
    return { matches: [], limit, truncated: false };
  }

  const result = await execRipgrep(options.rgCommand ?? DEFAULT_RIPGREP_COMMAND, [
    "--json",
    "--color",
    "never",
    "--line-number",
    "--column",
    "--with-filename",
    "--max-count",
    limit.toString(),
    "-e",
    regex,
    "--context",
    contextLines.toString(),
    "--glob",
    filePattern ?? "*",
    "--glob",
    "!.*",
    "--glob",
    "!**/.*",
    "--glob",
    "!**/node_modules/**",
    "--glob",
    "!**/dist/**",
    "--glob",
    "!**/coverage/**",
    "--glob",
    "!**/.git/**",
    ...resolvedPaths.map((resolved) => resolved.absolutePath),
  ]);

  if (result.exitCode === 2) {
    throw new SearchFilesError(normalizeRipgrepError(result.stderr, "ripgrep failed to run the search."));
  }

  if (result.exitCode !== 0 && result.exitCode !== 1 && result.exitCode !== null) {
    throw new SearchFilesError(normalizeRipgrepError(result.stderr, `ripgrep exited with code ${result.exitCode}.`));
  }

  return formatMatches(context, parseRipgrepOutput(result.stdout), contextLines, limit, result.stdoutTruncated);
}

function validatePaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new SearchFilesError("paths must be a non-empty array of strings.");
  }

  return paths.map((userPath) => {
    if (typeof userPath !== "string" || !userPath.trim()) {
      throw new SearchFilesError("paths must contain only non-empty strings.");
    }

    return userPath;
  });
}

function validateRegex(regex: unknown): string {
  if (typeof regex !== "string" || !regex.trim()) {
    throw new SearchFilesError("regex must be a non-empty string.");
  }

  return regex;
}

function validateFilePattern(filePattern: string | undefined): string | undefined {
  if (filePattern === undefined) {
    return undefined;
  }

  if (typeof filePattern !== "string" || !filePattern.trim()) {
    throw new SearchFilesError("filePattern must be a non-empty string when provided.");
  }

  return filePattern;
}

function validateContextLines(contextLines: number | undefined): number {
  if (contextLines === undefined) {
    return 0;
  }

  if (!Number.isFinite(contextLines) || !Number.isInteger(contextLines) || contextLines < 0) {
    throw new SearchFilesError("contextLines must be a non-negative integer when provided.");
  }

  return Math.min(contextLines, MAX_SEARCH_CONTEXT_LINES);
}

function validateLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_SEARCH_FILES_LIMIT;
  }

  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
    throw new SearchFilesError("limit must be a positive integer when provided.");
  }

  return Math.min(limit, MAX_SEARCH_FILES_LIMIT);
}

async function resolveSearchPaths(context: RuntimeContext, paths: string[]): Promise<ResolvedWorkspacePath[]> {
  const resolvedPaths: ResolvedWorkspacePath[] = [];
  const seen = new Set<string>();

  for (const userPath of paths) {
    const resolved = resolveWorkspacePath(context, userPath);
    const stat = await statPath(resolved);

    if (!stat.isFile() && !stat.isDirectory()) {
      continue;
    }

    if (isIgnoredRelativePath(resolved.relativePath)) {
      continue;
    }

    const seenKey = normalizeAbsolutePath(resolved.absolutePath);
    if (seen.has(seenKey)) {
      continue;
    }
    seen.add(seenKey);
    resolvedPaths.push(resolved);
  }

  return resolvedPaths;
}

async function statPath(resolved: ResolvedWorkspacePath): Promise<Stats> {
  try {
    return await fs.lstat(resolved.absolutePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new SearchFilesError(`Path '${resolved.inputPath}' does not exist.`);
    }

    throw new SearchFilesError(`Unable to inspect path '${resolved.inputPath}': ${getErrorMessage(error)}`);
  }
}

function execRipgrep(command: string, args: string[]): Promise<RipgrepResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutTruncated) {
        return;
      }

      const remainingBytes = MAX_RIPGREP_STDOUT_BYTES - stdoutBytes;
      if (chunk.length > remainingBytes) {
        stdoutTruncated = true;
        if (remainingBytes > 0) {
          stdoutChunks.push(chunk.subarray(0, remainingBytes));
          stdoutBytes += remainingBytes;
        }
        child.kill();
        return;
      }

      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const remainingBytes = MAX_RIPGREP_STDERR_BYTES - stderrBytes;
      if (remainingBytes <= 0) {
        return;
      }

      const bufferedChunk = chunk.length > remainingBytes ? chunk.subarray(0, remainingBytes) : chunk;
      stderrChunks.push(bufferedChunk);
      stderrBytes += bufferedChunk.length;
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new SearchFilesError("ripgrep executable 'rg' was not found on PATH. Install ripgrep to use search_files."));
        return;
      }

      reject(new SearchFilesError(`Unable to start ripgrep: ${error.message}`));
    });

    child.on("close", (exitCode) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
        stdoutTruncated,
      });
    });
  });
}

function parseRipgrepOutput(output: string): Map<string, ParsedFileResult> {
  const results = new Map<string, ParsedFileResult>();

  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine) {
      continue;
    }

    let message: RipgrepMessage;
    try {
      message = JSON.parse(rawLine) as RipgrepMessage;
    } catch {
      continue;
    }

    if (message.type !== "match" && message.type !== "context") {
      continue;
    }

    const absolutePath = message.data?.path?.text;
    const line = message.data?.line_number;
    const text = message.data?.lines?.text;

    if (!absolutePath || typeof line !== "number" || text === undefined) {
      continue;
    }

    const fileResult = getOrCreateFileResult(results, absolutePath);
    const isMatch = message.type === "match";
    if (isMatch || !fileResult.lines.has(line)) {
      fileResult.lines.set(line, {
        line,
        text: trimLineEnding(text),
        match: isMatch,
      });
    }

    if (isMatch) {
      const firstSubmatch = message.data?.submatches?.[0];
      fileResult.matches.push({
        absolutePath,
        line,
        column: firstSubmatch?.start === undefined ? undefined : firstSubmatch.start + 1,
        match: firstSubmatch?.match?.text ?? trimLineEnding(text),
      });
    }
  }

  return results;
}

function formatMatches(
  context: RuntimeContext,
  parsedResults: Map<string, ParsedFileResult>,
  contextLines: number,
  limit: number,
  forceTruncated = false,
): SearchFilesResult {
  const entries: SearchFilesEntry[] = [];
  const seenMatches = new Set<string>();
  const sortedFileResults = Array.from(parsedResults.entries()).sort(([leftPath], [rightPath]) =>
    leftPath.localeCompare(rightPath, "en"),
  );

  for (const [absolutePath, fileResult] of sortedFileResults) {
    const workspaceRoot = context.workspaceRoots.find((root) => isInsideResolvedRoot(root, absolutePath));
    if (!workspaceRoot) {
      continue;
    }

    const relativePath = toStableRelativePath(workspaceRoot, absolutePath);
    if (isIgnoredRelativePath(relativePath)) {
      continue;
    }

    const sortedMatches = fileResult.matches.sort((left, right) => left.line - right.line || (left.column ?? 0) - (right.column ?? 0));
    for (const parsedMatch of sortedMatches) {
      const matchKey = createMatchKey(absolutePath, parsedMatch);
      if (seenMatches.has(matchKey)) {
        continue;
      }

      if (entries.length >= limit) {
        return {
          matches: entries,
          limit,
          truncated: true,
        };
      }

      entries.push({
        path: absolutePath,
        relativePath,
        line: parsedMatch.line,
        ...(parsedMatch.column === undefined ? {} : { column: parsedMatch.column }),
        match: parsedMatch.match,
        ...(contextLines === 0 ? {} : { preview: buildPreview(fileResult.lines, parsedMatch.line, contextLines) }),
      });
      seenMatches.add(matchKey);
    }
  }

  return {
    matches: entries,
    limit,
    truncated: forceTruncated,
  };
}

function createMatchKey(absolutePath: string, parsedMatch: ParsedMatch): string {
  return `${normalizeAbsolutePath(absolutePath)}\0${parsedMatch.line}\0${parsedMatch.column ?? ""}\0${parsedMatch.match}`;
}

function buildPreview(lines: Map<number, ParsedLine>, matchLine: number, contextLines: number): SearchFilesContextLine[] {
  const start = matchLine - contextLines;
  const end = matchLine + contextLines;
  return Array.from(lines.values())
    .filter((line) => line.line >= start && line.line <= end)
    .sort((left, right) => left.line - right.line)
    .map((line) => ({
      line: line.line,
      text: line.text,
      match: line.match,
    }));
}

function getOrCreateFileResult(results: Map<string, ParsedFileResult>, absolutePath: string): ParsedFileResult {
  const existing = results.get(absolutePath);
  if (existing) {
    return existing;
  }

  const created = {
    lines: new Map<number, ParsedLine>(),
    matches: [],
  };
  results.set(absolutePath, created);
  return created;
}

function isIgnoredRelativePath(relativePath: string): boolean {
  return relativePath
    .split("/")
    .filter((part) => part.length > 0 && part !== ".")
    .some((part) => part.startsWith(".") || IGNORED_DIRECTORY_NAMES.has(part));
}

function isInsideResolvedRoot(workspaceRoot: string, absolutePath: string): boolean {
  return isPathInside(workspaceRoot, absolutePath);
}

function normalizeRipgrepError(stderr: string, fallback: string): string {
  const message = stderr.trim();
  return message || fallback;
}

function normalizeAbsolutePath(absolutePath: string): string {
  const normalized = path.resolve(absolutePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function trimLineEnding(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
