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
- Upstream `AnchorStateManager` stores anchors by task id and assigns randomized dictionary-word anchors while preserving unchanged lines through reconciliation.
- The MCP `read_file` port uses deterministic `Axxxxxxxx` anchors scoped by `RuntimeContext.sessionId`. It preserves anchors through an ordered LCS-style reconciliation over FNV-1a line hashes, with prefix/suffix fast paths and a bounded greedy fallback for very large changed regions. Matched unchanged lines keep anchors; inserted, edited, deleted/reappearing, or unmatched moved lines receive fresh anchors. Duplicate identical lines remain distinct and are matched by ordered sequence. This is intentionally different from Dirac's random dictionary words to make standalone MCP tests and sessions reproducible.

File extraction:

- Upstream supports text plus richer file types through `extract-file-content`.
- Relevant package dependencies include `isbinaryfile`, `pdf-parse`, `mammoth`, and `image-size`.
- The current MCP `read_file` port is text/code only. PDF, DOCX, XLSX, notebook, and image extraction are explicitly deferred with clear unsupported-file errors rather than partial extraction.

Tree-sitter:

- Required by `get_file_skeleton`, `get_function`, `replace_symbol`, and parts of symbol tooling.
- Relevant dependencies include `web-tree-sitter`, `tree-sitter-wasms`, and query files under `src/services/tree-sitter/queries`.
- Standalone packaging must copy or resolve WASM assets correctly from built `dist/`.

Symbol index:

- Required by `find_symbol_references` and `rename_symbol`.
- Upstream uses SQLite WASM and `.dirac-symbol-index/data.db`.
- MCP needs an explicit decision: persistent workspace index, session-scoped index, or no index until a consumer needs it.

Editing:

- `EditExecutor` is the cleanest pure component: it resolves anchors, verifies anchor text, and applies non-overlapping edits in memory. The MCP anchor contract should keep that shape: future `edit_file` should resolve anchors from current session/file state, require exact line-text matches from the `Anchor§line_text` reference, reject stale anchors, prevent one anchor from resolving to multiple lines, and reconcile anchors again after a successful write.
- `BatchProcessor` mixes pure edit flow with approval UI, VS Code diff saving, diagnostics, and file tracking.
- MCP mutation tools need a headless write path, diff output, and failure reporting.
- The first MCP `edit_file` port deliberately narrows Dirac's schema. Dirac accepts `files[]`, per-edit `edit_type`, `anchor`, `end_anchor`, and `text`, with `replace`, `insert_after`, and `insert_before`. The MCP tool accepts one `path` and `edits: { anchor, oldText, newText }[]` only.
- MCP `edit_file` anchor semantics: `anchor` is the start line from same-session `read_file`; the replacement span is derived from the number of logical lines in `oldText`. This avoids adding `end_anchor` until the current `read_file` contract needs it and keeps stale validation centered on exact current text.
- MCP `edit_file` stale behavior is more conservative than Dirac's prepare path. Dirac reconciles anchors against current file content before resolving edits; MCP consumes the existing anchor snapshot first, rejects line-count drift as stale, and requires exact `oldText` at the tracked start line.
- MCP `edit_file` applies all validated non-overlapping ranges bottom-to-top, writes once, then reconciles anchor state from the final file lines. Validation failures produce no write.
- MCP `edit_file` normalizes requested `oldText`/`newText` and current file content to LF for logical matching and deterministic diff output, while writing back with the file's dominant existing EOL and preserving final newline presence.
- MCP `edit_file` omits Dirac's approval UI, VS Code diff provider, dirty document save, diagnostics, auto-format/user-edit feedback, telemetry, multi-file batching, and insert-specific operations.

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

`read_file`:

- MCP production-ready under the current standalone text/code file scope.
- Upstream behavior inspected:
  - Schema accepts `paths`, optional `start_line`, and optional `end_line`.
  - `ReadFileToolHandler` supports multiple paths, one-based inclusive ranges, a 50KB full-read guard, `[File Hash: ...]`, and hash-anchored lines.
  - Upstream extraction supports text plus PDF, DOCX, IPYNB, XLSX, and model-gated images through extension dependencies.
  - Upstream anchors use `AnchorStateManager`, line FNV hashes, task id scoping, and the `§` delimiter.
- MCP behavior:
  - Accepts `paths`, camelCase `startLine`/`endLine`, Dirac-compatible `start_line`/`end_line`, and optional `lineLimit`.
  - Uses existing workspace guards plus realpath containment; rejects symlinks and directories.
  - Returns structured per-line output and line-numbered formatted text.
  - Uses deterministic session-scoped `Axxxxxxxx` anchors and FNV-1a content hashes.
  - Defers rich file extraction with explicit unsupported-file errors.

`edit_file`:

- MCP production-ready under the current standalone single-file text/code scope.
- Upstream behavior inspected:
  - Schema accepts multi-file `files[]`, per-edit `edit_type`, `anchor`, `end_anchor`, and replacement `text`.
  - `EditExecutor` resolves anchors, validates provided anchor line text, rejects reversed replace ranges, applies sorted edits bottom-to-top, and strips hashes from replacement text.
  - `BatchProcessor` groups blocks by path, prepares edits, routes through approval/diff UI and diagnostics, saves via host/diff provider, and refreshes `AnchorStateManager` after save.
  - `EditFormatter` returns Dirac-oriented anchored diff/result text and optionally full updated file content for extensive edits.
- MCP behavior:
  - Accepts one `path` and `edits: { anchor, oldText, newText }[]`.
  - Requires same-session `read_file` anchor state and exact `oldText` at the tracked start line.
  - Rejects stale line-count drift, unknown anchors, oldText mismatches, overlapping spans, and file safety errors before writing.
  - Applies edits bottom-to-top, writes once, refreshes anchor state, and returns structured output plus deterministic patch summary.
  - Defers multi-file batching, insert-specific operations, end-anchor ranges, approval UI, diagnostics, dirty-file mediation, and auto-format feedback.

## Next Likely Tool Area

`read_file` and the single-file `edit_file` foundation are now stable enough for conservative text/code editing. The next likely preparatory work is tree-sitter asset packaging for `get_file_skeleton` / `get_function`, or a separate design pass for optional `edit_file` insert/end-anchor extensions.

## Risks For Anchors, Tree-Sitter, And Editing

- Anchor drift: MCP sessions need stable ids and clear lifecycle rules, otherwise anchors generated by `read_file` may not be available to `edit_file`.
- Anchor storage: upstream state is in memory by task id; a long-lived MCP server may need cleanup or explicit reset behavior.
- Reorders/moves: MCP reconciliation preserves an ordered unchanged subsequence, matching Dirac's diff-style assumptions. It does not try to preserve every moved line across arbitrary reorder operations because that can make stale anchor reuse ambiguous for editing.
- Tree-sitter assets: WASM and query files must resolve after TypeScript build, not only from source-tree execution.
- AST parity: `ASTAnchorBridge` assumes upstream parser/index behavior and may need adaptation for MCP output shapes.
- Mutation safety: current `edit_file` avoids overlapping edits, stale line-count drift, oldText mismatches, and partial writes for single-file replacement. Future mutation extensions must preserve those guarantees.
- Host replacement: upstream mutation paths call VS Code-ish services such as `DiffViewProvider`, diagnostics providers, and `HostProvider.workspace.saveOpenDocumentIfDirty`; MCP needs direct filesystem equivalents or explicit omissions.
- Symbol index persistence: `.dirac-symbol-index` may be undesirable for a standalone MCP server unless the user opts in.
- Command execution: `execute_command` should remain unported until a sandbox/permission model is defined.

## Suggested Build Order

1. Maintain `list_files` and `search_files`; do not keep reworking them unless a verified bug appears.
2. Port `read_file` and define anchor session behavior.
3. Add tree-sitter packaging support.
4. Port `get_file_skeleton`.
5. Port `get_function`.
6. Maintain `edit_file`; consider insert/end-anchor extensions only in a dedicated session.
7. Consider symbol-index tools after persistence is decided.
8. Consider `execute_command` only with an explicit policy.
