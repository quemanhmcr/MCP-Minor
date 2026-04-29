import path from "node:path";

import type { RuntimeContext } from "../runtime/context.js";

export type WorkspacePathErrorCode = "invalid_path" | "outside_workspace";

export class WorkspacePathError extends Error {
  constructor(
    readonly code: WorkspacePathErrorCode,
    message: string,
    readonly inputPath: string,
  ) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export interface ResolvedWorkspacePath {
  inputPath: string;
  absolutePath: string;
  workspaceRoot: string;
  relativePath: string;
}

export function resolveWorkspacePath(context: RuntimeContext, userPath: string): ResolvedWorkspacePath {
  if (!userPath.trim()) {
    throw new WorkspacePathError("invalid_path", "Path must be a non-empty string.", userPath);
  }

  const normalizedInput = normalizeUserPath(userPath);
  const absolutePath = path.resolve(path.isAbsolute(normalizedInput) ? normalizedInput : path.join(context.cwd, normalizedInput));
  const workspaceRoots = context.workspaceRoots.map((root) => path.resolve(root));
  const workspaceRoot = workspaceRoots.find((root) => isPathInside(root, absolutePath));

  if (!workspaceRoot) {
    throw new WorkspacePathError(
      "outside_workspace",
      `Path '${userPath}' resolves outside the configured workspace roots.`,
      userPath,
    );
  }

  return {
    inputPath: userPath,
    absolutePath,
    workspaceRoot,
    relativePath: toStableRelativePath(workspaceRoot, absolutePath),
  };
}

export function isPathInside(workspaceRoot: string, candidatePath: string): boolean {
  const root = normalizeForComparison(path.resolve(workspaceRoot));
  const candidate = normalizeForComparison(path.resolve(candidatePath));
  const relative = path.relative(root, candidate);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function toStableRelativePath(workspaceRoot: string, absolutePath: string): string {
  const relativePath = path.relative(path.resolve(workspaceRoot), path.resolve(absolutePath));
  return relativePath === "" ? "." : relativePath.split(path.sep).join("/");
}

export function normalizeWorkspaceError(error: unknown): Error {
  if (error instanceof WorkspacePathError) {
    return error;
  }

  return error instanceof Error ? error : new Error(String(error));
}

function normalizeUserPath(userPath: string): string {
  return userPath.replaceAll("\\", path.sep);
}

function normalizeForComparison(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
