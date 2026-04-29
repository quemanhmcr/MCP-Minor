# Dirac Codebase Tools MCP Porting Tracker

## Project Goal

Build a standalone MCP server that ports only Dirac's important codebase-working tools. We are not porting Dirac's CLI, VS Code UI, provider/auth flow, task workflow, browser workflow, skills, or subagent system.

Each work session should port one tool, or one small shared dependency required by that tool, to keep context small and reviewable.

Source repo:

- Local source: `c:\project\lamviec\dirac-mcp\dirac`
- Upstream: `https://github.com/dirac-run/dirac`
- Initial inspected commit: `e827ec30d4cdae078588df2040f203b780d657ad`
- Source strategy: git submodule pinned by the root repository. Treat `dirac/` as read-only source material.

Primary research note:

- `DIRAC_TOOL_PORTING_NOTES.md`

MCP server project:

- Path: `c:\project\lamviec\dirac-mcp\mcp-server`
- Package manager: npm, with committed `package-lock.json`.
- Runtime: Node.js >= 20.11, ESM TypeScript.
- Transport: MCP stdio transport first. Do not add HTTP/SSE until a real consumer needs it.

## Porting Rules

- Build a new MCP server instead of trying to run Dirac's `ToolExecutor`.
- Reuse/port Dirac's pure logic where possible.
- Replace Dirac UI callbacks with MCP tool responses or MCP errors.
- Remove/no-op telemetry, approval UI, task workflow, webview behavior, and VS Code-specific host behavior.
- Keep tool APIs close to Dirac's existing schemas unless there is a strong MCP reason to simplify.
- Add tests for each ported tool before marking it done.
- Mark a tool done only after it is callable through MCP and has at least basic verification.

## How To Start A New Session

1. Read this file and `DIRAC_TOOL_PORTING_NOTES.md`.
2. Check repo status from `c:\project\lamviec\dirac-mcp` and do not revert unrelated changes.
3. Ensure the Dirac source submodule is present:

```powershell
git submodule update --init --recursive
git submodule status
```

4. Work in `mcp-server/` for MCP implementation unless inspecting upstream source under `dirac/`.
5. Install dependencies if needed:

```powershell
cd c:\project\lamviec\dirac-mcp\mcp-server
npm install
```

6. Before changing a tool status to `done`, run the relevant verification commands and record them in the session log.
7. Port at most one Dirac tool, or one small shared dependency, per session.

## Definition Of Done

For setup/shared dependency work:

- Code builds with `npm run build`.
- Tests pass with `npm run test`.
- Lint passes with `npm run lint`.
- Tracker documents any new technical decision or verification command.

For a ported Dirac tool:

- MCP tool schema is registered and callable through the MCP server.
- Handler is headless and does not depend on Dirac UI callbacks, telemetry, VS Code host APIs, or task workflow.
- Path handling is constrained to configured workspace roots.
- Basic automated tests cover success and at least one failure/edge case.
- Manual or automated MCP-level verification is recorded in the session log.

## Technical Decisions

- Standalone package lives in `mcp-server/`; the upstream `dirac/` clone remains read-only source material unless a session explicitly says otherwise.
- Root git repository tracks only MCP project source, documentation, configuration, lockfiles, and the `dirac/` submodule pointer.
- Upstream Dirac is represented as a git submodule at `dirac/`, pinned to `e827ec30d4cdae078588df2040f203b780d657ad`.
- Generated artifacts are ignored and must not be committed: `node_modules/`, `dist/`, `coverage/`, logs, local env files, and Dirac runtime indexes.
- Use npm because the upstream clone uses `package-lock.json` and there is no pnpm/yarn workspace requirement here.
- Use TypeScript `NodeNext`, strict mode, ESM, and explicit `.js` import specifiers for emitted Node compatibility.
- Use separate build/typecheck configs: `tsconfig.build.json` emits only runtime `src/`, while `tsconfig.json` typechecks tests and config.
- Use `@modelcontextprotocol/sdk` `McpServer` with `StdioServerTransport`.
- Keep server creation separate from stdio startup so tests can instantiate the server without opening transport streams.
- Initial runtime context contains `cwd`, `sessionId`, and `workspaceRoots`; future path guards and anchor state should use this context.
- Path resolution in `mcp-server/src/filesystem/workspace.ts` resolves relative user paths against `RuntimeContext.cwd`, permits absolute paths only inside `RuntimeContext.workspaceRoots`, rejects traversal and sibling-prefix escapes, normalizes Windows-style user separators, and returns stable slash-separated workspace-relative paths.
- `list_files` is registered through `McpServer.registerTool` with zod input/output schemas, read-only/idempotent annotations, and structured MCP output.
- `list_files` returns deterministic entries shaped as `{ path, type, relativePath }`, sorted by name within each listed directory. It skips generated/heavy directories: `node_modules`, `dist`, `coverage`, and `.git`.
- `list_files` validates direct calls defensively in addition to MCP zod validation: invalid limits fail fast, oversized limits clamp to `MAX_LIST_FILES_LIMIT`, duplicate/overlapping resolved entries are deduplicated, and missing paths fail fast with a concise tool error.
- MCP tool registration now flows through `mcp-server/src/tools/register.ts`, and shared response/error formatting lives in `mcp-server/src/tools/response.ts` so future tools can return consistent text JSON, `structuredContent`, and concise `isError` responses without stack traces.

## Verification Commands

Run from `c:\project\lamviec\dirac-mcp\mcp-server`:

```powershell
npm run build
npm run test
npm run lint
npm run typecheck
```

## Tool Status Table

Status meanings:

- `not_started`: not ported yet.
- `in_progress`: active session started but not complete.
- `blocked`: needs a decision or missing dependency.
- `ported`: implementation exists but verification is incomplete.
- `done`: implemented, callable, and verified.

| Tool | Status | Priority | Dirac Schema | Dirac Handler/Core | MCP Notes | Session Done |
| --- | --- | --- | --- | --- | --- | --- |
| `list_files` | `done` | P0 | `src/core/prompts/system-prompt/tools/list_files.ts` | `src/core/task/tools/handlers/ListFilesToolHandler.ts`, `src/services/glob/list-files.ts` | MCP implementation accepts `paths`, optional `recursive`, optional `limit`; returns structured `{ path, type, relativePath }` entries with workspace guarding and generated-directory ignores. | 2026-04-29 |
| `search_files` | `not_started` | P0 | `src/core/prompts/system-prompt/tools/search_files.ts` | `src/core/task/tools/handlers/SearchFilesToolHandler.ts`, `src/services/ripgrep/index.ts` | Needs `rg` strategy. Can use system `rg` first, then decide whether to vendor Dirac's binary lookup. |  |
| `read_file` | `not_started` | P0 | `src/core/prompts/system-prompt/tools/read_file.ts` | `src/core/task/tools/handlers/ReadFileToolHandler.ts`, `src/integrations/misc/extract-file-content.ts` | Important because it creates hash anchors for `edit_file`. Needs `AnchorStateManager` session id. |  |
| `get_file_skeleton` | `not_started` | P1 | `src/core/prompts/system-prompt/tools/get_file_skeleton.ts` | `src/core/task/tools/handlers/GetFileSkeletonToolHandler.ts`, `src/utils/ASTAnchorBridge.ts` | Requires tree-sitter WASM packaging and query files. Good after `read_file`. |  |
| `get_function` | `not_started` | P1 | `src/core/prompts/system-prompt/tools/get_function.ts` | `src/core/task/tools/handlers/GetFunctionToolHandler.ts`, `src/utils/ASTAnchorBridge.ts` | Requires tree-sitter and anchors. Supports multi-file/multi-function lookup. |  |
| `find_symbol_references` | `not_started` | P2 | `src/core/prompts/system-prompt/tools/find_symbol_references.ts` | `src/core/task/tools/handlers/FindSymbolReferencesToolHandler.ts`, `src/services/symbol-index` | Uses `SymbolIndexService` and SQLite WASM. Decide persistence vs in-memory/session-scoped index. |  |
| `edit_file` | `not_started` | P1 | `src/core/prompts/system-prompt/tools/edit_file.ts` | `src/core/task/tools/handlers/EditFileToolHandler.ts`, `src/core/task/tools/handlers/edit-file/*` | High value. Start from `EditExecutor`; replace `DiffViewProvider` with direct file writes and diff response. |  |
| `replace_symbol` | `not_started` | P2 | `src/core/prompts/system-prompt/tools/replace_symbol.ts` | `src/core/task/tools/handlers/ReplaceSymbolToolHandler.ts`, `src/utils/ASTAnchorBridge.ts` | Needs AST range resolution. Replace VS Code diff save with direct writes. |  |
| `rename_symbol` | `not_started` | P2 | `src/core/prompts/system-prompt/tools/rename_symbol.ts` | `src/core/task/tools/handlers/RenameSymbolToolHandler.ts`, `src/services/symbol-index` | Needs symbol index and careful diff/reporting. Higher blast radius. |  |
| `diagnostics_scan` | `not_started` | P3 | `src/core/prompts/system-prompt/tools/diagnostics_scan.ts` | `src/core/task/tools/handlers/DiagnosticsScanToolHandler.ts`, `src/integrations/diagnostics` | Optional. Dirac version is host/integration-heavy. Consider simple command-based diagnostics later. |  |
| `execute_command` | `not_started` | P3 | `src/core/prompts/system-prompt/tools/execute_command.ts` | `src/core/task/tools/handlers/ExecuteCommandToolHandler.ts` | Optional and risky. Needs explicit sandbox/permission policy before exposing via MCP. |  |

## Explicitly Out Of Scope

| Dirac Tool/Area | Reason |
| --- | --- |
| `ask_followup_question` | Agent conversation workflow, not codebase tooling. |
| `attempt_completion` | Agent task lifecycle, not MCP utility. |
| `plan_mode_respond` | Dirac-specific mode workflow. |
| `new_task` | Dirac task spawning/workflow. |
| `summarize_task` | Dirac context/task management. |
| `browser_action` | Browser session/UI state. Can be a separate MCP later if needed. |
| `use_skill`, `list_skills` | Dirac/Claude skill workflow, not core codebase tool. |
| `use_subagents` | Agent orchestration, not core codebase tool. |
| CLI auth/history/provider setup | Dirac product/runtime concerns. |
| VS Code webview/sidebar commands | UI-only concerns. |

## Shared Dependency Checklist

| Dependency Area | Status | Source Files | Notes |
| --- | --- | --- | --- |
| MCP server scaffold | `done` | `mcp-server/package.json`, `mcp-server/src/index.ts`, `mcp-server/src/server.ts` | TypeScript MCP SDK server with stdio transport. No Dirac tools registered yet. |
| Runtime context | `ported` | `mcp-server/src/runtime/context.ts` | Minimal `cwd`, session id, and workspace roots. Needs path guard expansion before file tools. |
| Path resolution | `done` | `src/core/workspace/*`, `src/utils/path.ts` | Slim MCP implementation added in `mcp-server/src/filesystem/workspace.ts`; supports cwd-relative/absolute paths, workspace-root guard, sibling-prefix rejection, Windows separator normalization, and stable relative paths. |
| Ignore rules | `ported` | `src/core/ignore/DiracIgnoreController.ts` | Minimal generated-directory ignores implemented for `list_files`: `node_modules`, `dist`, `coverage`, `.git`. Full `.diracignore` support remains future work. |
| Hash anchors | `not_started` | `src/utils/AnchorStateManager.ts`, `src/utils/line-hashing.ts`, `src/utils/.hash_anchors` | Required by `read_file`, `edit_file`, AST outputs. |
| Tree-sitter parsing | `not_started` | `src/services/tree-sitter/*` | Requires WASM files from `tree-sitter-wasms`. Verify package layout in MCP package. |
| Symbol index | `not_started` | `src/services/symbol-index/*` | Required by reference/rename tools. Decide persistence model. |
| Diff formatting | `not_started` | `src/core/task/tools/handlers/edit-file/EditFormatter.ts`, `diff` | Needed for mutation tools. |
| File extraction | `not_started` | `src/integrations/misc/extract-file-content.ts` | Text/PDF/DOCX/image handling. Can start text-only, then extend. |

## Session Log

Add one row per session. Keep it short so future sessions can resume quickly.

| Date | Session Goal | Status | Files Changed | Verification | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-04-29 | Clone Dirac and map tool porting strategy | `done` | `DIRAC_TOOL_PORTING_NOTES.md`, `PROJECT_PORTING_TRACKER.md` | Manual repo inspection | Confirmed no existing MCP server; plan is standalone MCP with codebase tools only. |
| 2026-04-29 | Scaffold standalone MCP server foundation | `done` | `.gitignore`, `README.md`, `mcp-server/*`, `PROJECT_PORTING_TRACKER.md` | `npm run build`; `npm run test`; `npm run lint`; `npm run typecheck` | Created npm TypeScript MCP SDK package using stdio transport. No Dirac tool was ported. |
| 2026-04-29 | Normalize git/project hygiene | `done` | `.gitignore`, `.gitmodules`, `README.md`, `PROJECT_PORTING_TRACKER.md` | `git status --short`; `npm run build`; `npm run test`; `npm run lint`; `npm run typecheck` | Initialized root git repo, recorded `dirac/` as submodule pinned to `e827ec30d4cdae078588df2040f203b780d657ad`, kept generated artifacts ignored. No Dirac tool was ported. |
| 2026-04-29 | Port `list_files` and filesystem guard foundation | `done` | `README.md`, `PROJECT_PORTING_TRACKER.md`, `mcp-server/src/filesystem/*`, `mcp-server/src/tools/list-files.ts`, `mcp-server/src/server.ts`, `mcp-server/test/*` | `npm run build`; `npm run test`; `npm run lint`; `npm run typecheck` | Added reusable workspace path guard, deterministic read-only listing, generated-directory ignores, zod schemas, and MCP in-memory smoke test. |
| 2026-04-29 | Harden `list_files` for commit readiness | `done` | `PROJECT_PORTING_TRACKER.md`, `mcp-server/src/filesystem/list-files.ts`, `mcp-server/test/list-files.test.ts`, `mcp-server/test/list-files-mcp.test.ts` | `npm run build`; `npm run test`; `npm run lint`; `npm run typecheck` | Added direct input validation, invalid-limit handling, duplicate result dedupe, missing-path fail-fast errors, and MCP out-of-workspace error coverage. No new Dirac tool was ported. |
| 2026-04-29 | Standardize MCP tool registration and responses | `done` | `PROJECT_PORTING_TRACKER.md`, `mcp-server/src/server.ts`, `mcp-server/src/tools/list-files.ts`, `mcp-server/src/tools/register.ts`, `mcp-server/src/tools/response.ts`, `mcp-server/test/tool-response.test.ts` | `npm run build`; `npm run test`; `npm run lint`; `npm run typecheck` | Moved tool registration behind `registerTools`, added shared structured success and concise tool error response helpers, and refactored `list_files` to use them. No new Dirac tool was ported. |

## Session Completion Template

Use this at the end of each porting session:

```text
Session:
Tool/dependency:
Status: not_started | in_progress | blocked | ported | done
Files changed:
Tests/verification:
Remaining work:
Next recommended session:
```
