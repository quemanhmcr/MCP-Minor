import path from "node:path";

export interface RuntimeContext {
  cwd: string;
  sessionId: string;
  workspaceRoots: string[];
}

export function createRuntimeContext(env: NodeJS.ProcessEnv = process.env): RuntimeContext {
  const cwd = path.resolve(env.DIRAC_MCP_CWD ?? process.cwd());
  const sessionId = env.DIRAC_MCP_SESSION_ID ?? "default";
  const workspaceRoots = parseWorkspaceRoots(env.DIRAC_MCP_WORKSPACE_ROOTS, cwd);

  return {
    cwd,
    sessionId,
    workspaceRoots,
  };
}

function parseWorkspaceRoots(value: string | undefined, fallback: string): string[] {
  if (!value?.trim()) {
    return [fallback];
  }

  const roots = value
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => path.resolve(root));

  return roots.length > 0 ? roots : [fallback];
}
