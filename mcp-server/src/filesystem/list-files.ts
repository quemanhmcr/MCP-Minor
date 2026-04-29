import { promises as fs, type Dirent, type Stats } from "node:fs";
import path from "node:path";

import type { RuntimeContext } from "../runtime/context.js";
import { type ResolvedWorkspacePath, resolveWorkspacePath, toStableRelativePath } from "./workspace.js";

export const DEFAULT_LIST_FILES_LIMIT = 200;
export const MAX_LIST_FILES_LIMIT = 1_000;

const IGNORED_DIRECTORY_NAMES = new Set(["node_modules", "dist", "coverage", ".git"]);

export class ListFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListFilesError";
  }
}

export interface ListFilesInput {
  paths: string[];
  recursive?: boolean;
  limit?: number;
}

export interface ListFilesEntry {
  path: string;
  type: "file" | "directory";
  relativePath: string;
}

export interface ListFilesResult {
  entries: ListFilesEntry[];
  limit: number;
  truncated: boolean;
}

interface WalkState {
  entries: ListFilesEntry[];
  limit: number;
  truncated: boolean;
  seenAbsolutePaths: Set<string>;
}

export async function listWorkspaceFiles(context: RuntimeContext, input: ListFilesInput): Promise<ListFilesResult> {
  const paths = validatePaths(input.paths);
  const limit = validateLimit(input.limit);
  const state: WalkState = {
    entries: [],
    limit,
    truncated: false,
    seenAbsolutePaths: new Set(),
  };

  for (const userPath of paths) {
    if (state.entries.length >= state.limit) {
      state.truncated = true;
      break;
    }

    const resolved = resolveWorkspacePath(context, userPath);
    await listResolvedPath(resolved, Boolean(input.recursive), state);
  }

  return {
    entries: state.entries,
    limit,
    truncated: state.truncated,
  };
}

function validatePaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new ListFilesError("paths must be a non-empty array of strings.");
  }

  return paths.map((userPath) => {
    if (typeof userPath !== "string" || !userPath.trim()) {
      throw new ListFilesError("paths must contain only non-empty strings.");
    }

    return userPath;
  });
}

function validateLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIST_FILES_LIMIT;
  }

  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
    throw new ListFilesError("limit must be a positive integer when provided.");
  }

  return Math.min(limit, MAX_LIST_FILES_LIMIT);
}

async function listResolvedPath(resolved: ResolvedWorkspacePath, recursive: boolean, state: WalkState): Promise<void> {
  const stat = await statPath(resolved);

  if (stat.isFile()) {
    pushEntry(state, resolved, resolved.absolutePath, "file");
    return;
  }

  if (!stat.isDirectory()) {
    return;
  }

  await listDirectory(resolved, resolved.absolutePath, recursive, state);
}

async function statPath(resolved: ResolvedWorkspacePath): Promise<Stats> {
  try {
    return await fs.stat(resolved.absolutePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new ListFilesError(`Path '${resolved.inputPath}' does not exist.`);
    }

    throw new ListFilesError(`Unable to inspect path '${resolved.inputPath}': ${getErrorMessage(error)}`);
  }
}

async function listDirectory(
  resolved: ResolvedWorkspacePath,
  directoryPath: string,
  recursive: boolean,
  state: WalkState,
): Promise<void> {
  const entries = await readDirectory(resolved, directoryPath);
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

  for (const entry of entries) {
    if (state.entries.length >= state.limit) {
      state.truncated = true;
      return;
    }

    if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(directoryPath, entry.name);
    const type = entry.isDirectory() ? "directory" : "file";
    pushEntry(state, resolved, absolutePath, type);

    if (recursive && entry.isDirectory()) {
      await listDirectory(resolved, absolutePath, recursive, state);
    }
  }
}

async function readDirectory(resolved: ResolvedWorkspacePath, directoryPath: string): Promise<Dirent<string>[]> {
  try {
    return await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    const relativePath = toStableRelativePath(resolved.workspaceRoot, directoryPath);
    throw new ListFilesError(`Unable to read directory '${relativePath}': ${getErrorMessage(error)}`);
  }
}

function pushEntry(
  state: WalkState,
  resolved: ResolvedWorkspacePath,
  absolutePath: string,
  type: ListFilesEntry["type"],
): void {
  if (state.entries.length >= state.limit) {
    state.truncated = true;
    return;
  }

  const seenKey = normalizeAbsolutePath(absolutePath);
  if (state.seenAbsolutePaths.has(seenKey)) {
    return;
  }
  state.seenAbsolutePaths.add(seenKey);

  state.entries.push({
    path: absolutePath,
    type,
    relativePath: toStableRelativePath(resolved.workspaceRoot, absolutePath),
  });
}

function normalizeAbsolutePath(absolutePath: string): string {
  const normalized = path.resolve(absolutePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
