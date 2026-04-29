# Dirac Tool Porting Notes

Upstream research/reference note for the standalone MCP port. Use `PROJECT_PORTING_TRACKER.md` for current status, session history, and operational rules.

Repo cloned: `dirac-run/dirac`
Local path: `c:\project\lamviec\dirac-mcp\dirac`
Pinned source commit: `e827ec30d4cdae078588df2040f203b780d657ad`

## Upstream Dirac Architecture

Dirac is a TypeScript coding agent forked from Cline. It ships as:

- VS Code extension from repo root.
- CLI package under `cli/`.
- Shared core under `src/core`, `src/services`, `src/utils`, and `src/shared`.

Upstream Dirac does not expose a usable MCP server runtime. The standalone MCP package should treat Dirac's tool schemas and service logic as source material, not as a framework to boot directly.

Schema layer:

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

Important porting implication: handlers depend on `TaskConfig`, which carries UI callbacks, telemetry, approval state, workspace resolution, ignore rules, diff view, diagnostics, browser/session state, command runner, and task state. MCP ports should extract pure behavior and replace those host concerns with explicit MCP responses, errors, or configuration.

## Useful Source Files

Read-only filesystem/search:

- `src/core/prompts/system-prompt/tools/list_files.ts`
- `src/core/task/tools/handlers/ListFilesToolHandler.ts`
- `src/services/glob/list-files.ts`
- `src/core/prompts/system-prompt/tools/search_files.ts`
- `src/core/task/tools/handlers/SearchFilesToolHandler.ts`
- `src/services/ripgrep/index.ts`

Read file and anchors:

- `src/core/prompts/system-prompt/tools/read_file.ts`
- `src/core/task/tools/handlers/ReadFileToolHandler.ts`
- `src/integrations/misc/extract-file-content.ts`
- `src/utils/AnchorStateManager.ts`
- `src/utils/line-hashing.ts`
- `src/shared/utils/line-hashing.ts`
- `src/utils/.hash_anchors`

AST and symbol tools:

- `src/core/prompts/system-prompt/tools/get_file_skeleton.ts`
- `src/core/task/tools/handlers/GetFileSkeletonToolHandler.ts`
- `src/core/prompts/system-prompt/tools/get_function.ts`
- `src/core/task/tools/handlers/GetFunctionToolHandler.ts`
- `src/core/prompts/system-prompt/tools/find_symbol_references.ts`
- `src/core/task/tools/handlers/FindSymbolReferencesToolHandler.ts`
- `src/utils/ASTAnchorBridge.ts`
- `src/services/tree-sitter/index.ts`
- `src/services/tree-sitter/languageParser.ts`
- `src/services/tree-sitter/queries/*.ts`
- `src/services/symbol-index/SymbolIndexService.ts`
- `src/services/symbol-index/SymbolIndexDatabase.ts`
- `src/services/symbol-index/sql-wasm.wasm`

Editing and mutation tools:

- `src/core/prompts/system-prompt/tools/edit_file.ts`
- `src/core/task/tools/handlers/EditFileToolHandler.ts`
- `src/core/task/tools/handlers/edit-file/BatchProcessor.ts`
- `src/core/task/tools/handlers/edit-file/EditExecutor.ts`
- `src/core/task/tools/handlers/edit-file/EditFormatter.ts`
- `src/core/task/tools/handlers/edit-file/types.ts`
- `src/core/task/tools/handlers/ReplaceSymbolToolHandler.ts`
- `src/core/task/tools/handlers/RenameSymbolToolHandler.ts`

Workspace/path support:

- `src/core/workspace/WorkspaceResolver.ts`
- `src/core/workspace/WorkspacePathAdapter.ts`
- `src/core/workspace/utils/parseWorkspaceInlinePath.ts`
- `src/core/ignore/DiracIgnoreController.ts`
- `src/utils/path.ts`
- `src/utils/fs.ts`

## Porting Dependencies

Hash anchors:

- Required for `read_file`, `search_files` anchored formatted output, `edit_file`, and AST outputs.
- Upstream `AnchorStateManager` stores anchors by task id. MCP needs a stable session/task-id policy.

File extraction:

- Upstream supports text plus richer file types through `extract-file-content`.
- Relevant package dependencies include `isbinaryfile`, `pdf-parse`, `mammoth`, and `image-size`.
- A practical MCP port can start text-only if the richer extraction path is too large for one session, but this must be documented as partial parity.

Tree-sitter:

- Required by `get_file_skeleton`, `get_function`, `replace_symbol`, and parts of symbol tooling.
- Relevant dependencies include `web-tree-sitter`, `tree-sitter-wasms`, and query files under `src/services/tree-sitter/queries`.
- Standalone packaging must copy or resolve WASM assets correctly from built `dist/`.

Symbol index:

- Required by `find_symbol_references` and `rename_symbol`.
- Upstream uses SQLite WASM and `.dirac-symbol-index/data.db`.
- MCP needs an explicit decision: persistent workspace index, session-scoped index, or no index until a consumer needs it.

Editing:

- `EditExecutor` is the cleanest pure component: it resolves anchors, verifies anchor text, and applies non-overlapping edits in memory.
- `BatchProcessor` mixes pure edit flow with approval UI, VS Code diff saving, diagnostics, and file tracking.
- MCP mutation tools need a headless write path, diff output, and failure reporting.

Ignore rules:

- Upstream list/search integrate gitignore and/or `DiracIgnoreController`.
- Current MCP ports deliberately defer `.diracignore`; they rely on workspace-root containment and built-in generated/hidden skips.

Ripgrep:

- Upstream locates a bundled or known `rg` via `getBinaryLocation("rg")`.
- Current MCP `search_files` uses system `rg` on `PATH`.

## Already-Ported Read-Only Filesystem Tools

`list_files`:

- MCP production-ready under the current standalone scope.
- Core purpose ported: workspace-constrained file/directory listing.
- Intentional differences from Dirac: structured JSON output, no line counts/mtimes, no globby/gitignore integration, no `.diracignore`, and hidden non-git paths remain visible.

`search_files`:

- MCP production-ready under the current standalone scope.
- Core ripgrep JSON search behavior ported.
- Dirac-parity caveats documented in the tracker: hidden path exclusion, byte columns, and first submatch only for same-line multiple matches.
- Intentional differences from Dirac: structured JSON output, no hash-anchored formatted text, no `DiracIgnoreController`, and system `rg`.

## Next Likely Tool: `read_file`

Recommended next implementation session:

1. Read upstream schema and handler:
   - `src/core/prompts/system-prompt/tools/read_file.ts`
   - `src/core/task/tools/handlers/ReadFileToolHandler.ts`
2. Inspect extraction and anchor utilities:
   - `src/integrations/misc/extract-file-content.ts`
   - `src/utils/AnchorStateManager.ts`
   - `src/utils/line-hashing.ts`
   - `src/shared/utils/line-hashing.ts`
3. Decide first-session scope:
   - Text files only, or full upstream extraction parity.
   - Single path versus multiple paths, matching upstream schema.
   - Line range behavior and output shape.
4. Add tests for:
   - Workspace-root rejection.
   - Missing file errors.
   - Text read with line ranges.
   - Anchor creation/reconciliation if included.
   - MCP in-memory call coverage.

Do not start editing tools until `read_file` and anchor behavior are stable.

## Risks For Anchors, Tree-Sitter, And Editing

- Anchor drift: MCP sessions need stable ids and clear lifecycle rules, otherwise anchors generated by `read_file` may not be available to `edit_file`.
- Anchor storage: upstream state is in memory by task id; a long-lived MCP server may need cleanup or explicit reset behavior.
- Tree-sitter assets: WASM and query files must resolve after TypeScript build, not only from source-tree execution.
- AST parity: `ASTAnchorBridge` assumes upstream parser/index behavior and may need adaptation for MCP output shapes.
- Mutation safety: editing tools must avoid overlapping edits, stale anchors, partial writes, and unclear diff reporting.
- Host replacement: upstream mutation paths call VS Code-ish services such as `DiffViewProvider`, diagnostics providers, and `HostProvider.workspace.saveOpenDocumentIfDirty`; MCP needs direct filesystem equivalents or explicit omissions.
- Symbol index persistence: `.dirac-symbol-index` may be undesirable for a standalone MCP server unless the user opts in.
- Command execution: `execute_command` should remain unported until a sandbox/permission model is defined.

## Suggested Build Order

1. Maintain `list_files` and `search_files`; do not keep reworking them unless a verified bug appears.
2. Port `read_file` and define anchor session behavior.
3. Add tree-sitter packaging support.
4. Port `get_file_skeleton`.
5. Port `get_function`.
6. Port `edit_file` with direct writes and diff output.
7. Consider symbol-index tools after persistence is decided.
8. Consider `execute_command` only with an explicit policy.
