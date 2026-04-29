# Dirac Tool Porting Notes

Repo cloned: `dirac-run/dirac`
Local path: `c:\project\lamviec\dirac-mcp\dirac`

## What Dirac Is

Dirac is a TypeScript coding agent forked from Cline. It ships as:

- VS Code extension from repo root.
- CLI package under `cli/`.
- Shared core under `src/core`, `src/services`, `src/utils`, `src/shared`.

The upstream README explicitly says MCP is not supported as a runtime feature. The dependency `@modelcontextprotocol/sdk` exists in `package.json`, but current `src` and `cli` code do not expose a real MCP server. For an MCP rewrite, treat Dirac's internal tools as source material, not as an existing MCP implementation.

## Key Architecture

Tool schema layer:

- `src/core/prompts/system-prompt/tools/*.ts`
- `src/core/prompts/system-prompt/tools/init.ts`
- `src/core/prompts/system-prompt/registry/DiracToolSet.ts`
- `src/core/prompts/system-prompt/spec.ts`
- `src/shared/tools.ts`

Execution layer:

- `src/core/task/ToolExecutor.ts`
- `src/core/task/tools/ToolExecutorCoordinator.ts`
- `src/core/task/tools/handlers/*.ts`
- `src/core/task/tools/types/TaskConfig.ts`
- `src/core/task/tools/ToolValidator.ts`

The schema layer defines `DiracToolSpec` and converts it into OpenAI, Anthropic, or Gemini native tool schemas. MCP can reuse the same names/descriptions/JSON-ish parameter structure, but should emit MCP tool definitions instead.

The execution layer routes tool calls through `ToolExecutorCoordinator`, which maps `DiracDefaultTool` enum values to handler classes. Handlers currently depend on `TaskConfig`, which carries UI callbacks, telemetry, approval state, workspace resolution, ignore rules, diff view, diagnostics, browser/session, command runner, and task state.

## Tools Worth Porting First

High value and relatively MCP-friendly:

- `list_files`: directory/file listing via `src/services/glob/list-files.ts`.
- `search_files`: ripgrep-based regex search via `src/services/ripgrep/index.ts`.
- `read_file`: reads text/images/PDF/DOCX and returns hash-anchored lines.
- `get_file_skeleton`: tree-sitter structural outline.
- `get_function`: tree-sitter extraction of specific functions/methods with anchors.
- `find_symbol_references`: AST-aware symbol reference lookup.

High value but more work:

- `edit_file`: hash-anchored multi-file edits. Core files are under `src/core/task/tools/handlers/edit-file/`.
- `replace_symbol`: AST-node replacement through `ASTAnchorBridge.getSymbolRange`.
- `rename_symbol`: AST-aware rename over files/directories.
- `diagnostics_scan`: depends on diagnostics providers and host integration.

Not useful as standalone MCP tools initially:

- `ask_followup_question`, `attempt_completion`, `plan_mode_respond`, `new_task`, `summarize_task`: agent workflow/UI tools.
- `browser_action`: possible later, but carries browser session and screenshot state.
- `use_skill`, `list_skills`, `use_subagents`: Dirac-specific agent features.

## Core Porting Dependencies

Hash anchors:

- `src/utils/AnchorStateManager.ts`
- `src/utils/line-hashing.ts`
- `src/shared/utils/line-hashing.ts`
- `src/utils/.hash_anchors`

AST tools:

- `src/utils/ASTAnchorBridge.ts`
- `src/services/tree-sitter/index.ts`
- `src/services/tree-sitter/languageParser.ts`
- `src/services/tree-sitter/queries/*.ts`
- `src/services/symbol-index/SymbolIndexService.ts`
- `src/services/symbol-index/SymbolIndexDatabase.ts`
- `src/services/symbol-index/sql-wasm.wasm`
- package deps: `web-tree-sitter`, `tree-sitter-wasms`, `diff`

Filesystem/search:

- `src/services/glob/list-files.ts`
- `src/services/ripgrep/index.ts`
- `src/integrations/misc/extract-file-content.ts`
- `src/core/ignore/DiracIgnoreController.ts`
- package deps: `globby`, `isbinaryfile`, `pdf-parse`, `mammoth`, `image-size`
- external/bundled tool: `rg`, located by `src/utils/fs.ts`

Editing:

- `src/core/task/tools/handlers/edit-file/BatchProcessor.ts`
- `src/core/task/tools/handlers/edit-file/EditExecutor.ts`
- `src/core/task/tools/handlers/edit-file/EditFormatter.ts`
- `src/core/task/tools/handlers/edit-file/types.ts`
- `src/core/task/tools/handlers/EditFileToolHandler.ts`
- `src/core/task/tools/handlers/ReplaceSymbolToolHandler.ts`
- `src/core/task/tools/handlers/RenameSymbolToolHandler.ts`

`EditExecutor` is the cleanest part of the edit stack: it resolves anchors, checks that anchor text still matches the file, and applies non-overlapping edits in memory. `BatchProcessor` is useful but mixes the pure edit flow with approval UI, VS Code diff saving, diagnostics, and file tracking.

`find_symbol_references` and `rename_symbol` use `SymbolIndexService`, which indexes supported source files into a SQLite WASM database at `.dirac-symbol-index/data.db`. For MCP, either make this index explicitly initialized per workspace or disable persistence and keep it in memory/session-scoped.

Workspace/path support:

- `src/core/workspace/WorkspaceResolver.ts`
- `src/core/workspace/WorkspacePathAdapter.ts`
- `src/core/workspace/utils/parseWorkspaceInlinePath.ts`
- `src/utils/path.ts`
- `src/utils/fs.ts`

## MCP Design Recommendation

Build a fresh MCP server package instead of trying to boot `ToolExecutor`. Use Dirac code as libraries.

Suggested initial tool API:

- `list_files({ paths, recursive })`
- `search_files({ paths, regex, file_pattern?, context_lines? })`
- `read_file({ paths, start_line?, end_line? })`
- `get_file_skeleton({ paths })`
- `get_function({ paths, function_names })`
- `find_symbol_references({ paths, symbols, find_type? })`
- `edit_file({ files })`
- `replace_symbol({ replacements })`
- `rename_symbol({ paths, existing_symbol, new_symbol })`

MCP server should provide a slim runtime context:

- `cwd`
- optional workspace roots
- ignore controller
- anchor task/session id
- approval policy, if desired
- command runner only if `execute_command` is included

Replace Dirac UI behavior:

- `callbacks.say/ask` -> return MCP content or throw MCP error.
- approval prompts -> configurable policy or omit from server.
- telemetry -> remove or no-op.
- checkpoint/diff view -> direct file writes plus generated diff in response.
- VS Code host calls -> direct filesystem where possible.

## Main Risks

- `edit_file`, `replace_symbol`, and `rename_symbol` currently route changes through VS Code-ish services like `DiffViewProvider`, diagnostics providers, and `HostProvider.workspace.saveOpenDocumentIfDirty`. These need a headless replacement.
- `AnchorStateManager` stores anchors in memory by task id. MCP sessions need stable session/task ids or anchors will drift between calls.
- Tree-sitter WASM loading uses `__dirname`, `process.cwd()`, and package-relative paths. A standalone MCP package must copy/bundle WASM assets and `.hash_anchors`.
- Some formatting strings contain mojibake box-drawing characters in this clone output. Functionally harmless, but worth normalizing in a clean MCP implementation.
- `execute_command` is powerful and needs a deliberate sandbox/permission story before exposing it as MCP.

## Recommended Build Order

1. Scaffold a standalone TypeScript MCP server package.
2. Port `DiracToolSpec` into MCP tool definitions or hand-write schemas from the existing specs.
3. Implement minimal `RuntimeContext` with cwd, path resolution, `.diracignore`, and anchor session id.
4. Port read-only tools first: list/search/read/skeleton/function/references.
5. Add tests using existing fixtures under `src/services/tree-sitter/__tests__/fixtures`.
6. Port `edit_file` with direct filesystem writes and diff output.
7. Port AST mutation tools after edit-file is stable.
8. Decide separately whether command execution belongs in this MCP server.
