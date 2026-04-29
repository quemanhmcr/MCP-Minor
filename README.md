# Dirac MCP Port

Standalone MCP server for selected Dirac codebase tools.

This repository keeps upstream Dirac under `dirac/` as a pinned git submodule used only as source material. The MCP server lives in `mcp-server/` and is intentionally headless: no Dirac CLI, VS Code UI, provider/auth flow, browser workflow, skills, or subagent runtime.

## Project Layout

- `dirac/`: pinned submodule of `dirac-run/dirac`.
- `mcp-server/`: standalone TypeScript MCP server package.
- `DIRAC_TOOL_PORTING_NOTES.md`: research notes from upstream inspection.
- `PROJECT_PORTING_TRACKER.md`: session tracker, status table, and working rules.

## Clone And Setup

Clone with submodules:

```powershell
git clone --recurse-submodules <repo-url>
cd dirac-mcp
```

If the repository was cloned without submodules:

```powershell
git submodule update --init --recursive
```

Install and verify the MCP server:

```powershell
cd mcp-server
npm install
npm run build
npm run test
npm run lint
npm run typecheck
```

Run the server over stdio:

```powershell
npm run dev
```

## Git Hygiene

- Use focused branches, for example `setup/mcp-scaffold` or `tool/list-files`.
- Keep commits scoped to one setup step, tool, or shared dependency.
- Treat `dirac/` as read-only upstream source material. Do not edit files inside the submodule during MCP porting sessions.
- Keep generated artifacts out of commits: `node_modules/`, `dist/`, `coverage/`, logs, local env files, and runtime indexes are ignored.
- Commit `mcp-server/package-lock.json` with package changes so future sessions are reproducible.
