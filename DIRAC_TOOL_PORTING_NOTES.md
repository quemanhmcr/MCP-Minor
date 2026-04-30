# Dirac Upstream Notes

This file contains durable upstream Dirac research for future ports. It does not track current MCP implementation status; use [PROJECT_PORTING_TRACKER.md](PROJECT_PORTING_TRACKER.md) for live status and [README.md](README.md) for MCP tool contracts.

Upstream repo: `dirac-run/dirac`
Local submodule: `dirac/`
Pinned source commit: `e827ec30d4cdae078588df2040f203b780d657ad`

## Upstream Architecture Overview

Dirac is a TypeScript coding agent forked from Cline. It ships primarily as a VS Code extension, with a CLI package under `cli/` and shared core/services under `src/`.

Tool definitions and prompt-facing schemas are separate from execution. Tool schema files live under `src/core/prompts/system-prompt/tools/`, while execution flows through task/tool handler classes under `src/core/task/tools/`.

Dirac handlers assume host services that a standalone MCP server does not have: UI callbacks, approval state, telemetry, VS Code diff views, diagnostics, browser/session state, command execution, provider/auth state, task state, and ignore controllers. MCP ports should extract pure behavior and replace host concerns with explicit MCP responses, errors, or configuration.

The upstream repo does not expose a reusable MCP server runtime. Treat Dirac as source material, not as a framework to boot directly.

## Source Map

| Capability | Upstream paths | Notes |
| --- | --- | --- |
| Tool schemas | `src/core/prompts/system-prompt/tools/*.ts`, `src/core/prompts/system-prompt/tools/init.ts`, `src/core/prompts/system-prompt/registry/DiracToolSet.ts`, `src/core/prompts/system-prompt/spec.ts`, `src/shared/tools.ts` | Prompt-facing contracts and registry wiring. |
| Tool execution | `src/core/task/ToolExecutor.ts`, `src/core/task/tools/ToolExecutorCoordinator.ts`, `src/core/task/tools/handlers/*.ts`, `src/core/task/tools/types/TaskConfig.ts`, `src/core/task/tools/ToolValidator.ts` | Handler code depends heavily on task/host services. |
| File listing | `src/core/prompts/system-prompt/tools/list_files.ts`, `src/core/task/tools/handlers/ListFilesToolHandler.ts`, `src/services/glob/list-files.ts` | Upstream integrates glob/gitignore-style behavior. |
| Search | `src/core/prompts/system-prompt/tools/search_files.ts`, `src/core/task/tools/handlers/SearchFilesToolHandler.ts`, `src/services/ripgrep/index.ts` | Upstream locates a bundled/known `rg`. |
| File read/extract | `src/core/prompts/system-prompt/tools/read_file.ts`, `src/core/task/tools/handlers/ReadFileToolHandler.ts`, `src/integrations/misc/extract-file-content.ts` | Supports text plus richer file extraction through dependencies. |
| Anchors | `src/utils/AnchorStateManager.ts`, `src/utils/line-hashing.ts`, `src/shared/utils/line-hashing.ts`, `src/utils/.hash_anchors` | Upstream anchor ids are randomized dictionary words scoped by task state. |
| Editing | `src/core/prompts/system-prompt/tools/edit_file.ts`, `src/core/task/tools/handlers/EditFileToolHandler.ts`, `src/core/task/tools/handlers/edit-file/BatchProcessor.ts`, `src/core/task/tools/handlers/edit-file/EditExecutor.ts`, `src/core/task/tools/handlers/edit-file/EditFormatter.ts`, `src/core/task/tools/handlers/edit-file/types.ts` | `EditExecutor` is the cleanest pure edit component; `BatchProcessor` mixes host UI/diff/diagnostics. |
| AST skeleton/function | `src/core/prompts/system-prompt/tools/get_file_skeleton.ts`, `src/core/task/tools/handlers/GetFileSkeletonToolHandler.ts`, `src/core/prompts/system-prompt/tools/get_function.ts`, `src/core/task/tools/handlers/GetFunctionToolHandler.ts`, `src/utils/ASTAnchorBridge.ts`, `src/services/tree-sitter/index.ts`, `src/services/tree-sitter/languageParser.ts`, `src/services/tree-sitter/queries/*.ts` | AST tools depend on tree-sitter parsing, query captures, and upstream anchor bridge behavior. |
| Symbol index | `src/core/prompts/system-prompt/tools/find_symbol_references.ts`, `src/core/task/tools/handlers/FindSymbolReferencesToolHandler.ts`, `src/core/task/tools/handlers/ReplaceSymbolToolHandler.ts`, `src/core/task/tools/handlers/RenameSymbolToolHandler.ts`, `src/services/symbol-index/SymbolIndexService.ts`, `src/services/symbol-index/SymbolIndexDatabase.ts`, `src/services/symbol-index/sql-wasm.wasm` | Upstream uses SQLite WASM and workspace index storage. |
| Workspace/path | `src/core/workspace/WorkspaceResolver.ts`, `src/core/workspace/WorkspacePathAdapter.ts`, `src/core/workspace/utils/parseWorkspaceInlinePath.ts`, `src/core/ignore/DiracIgnoreController.ts`, `src/utils/path.ts`, `src/utils/fs.ts` | MCP needs explicit workspace-root containment instead of VS Code workspace assumptions. |

## Porting Dependency Graph

- `anchors` depend on line hashing and session/file state only.
- `read_file` depends on workspace safety, text extraction, hashing, and anchors.
- `edit_file` depends on edit-ready anchor state, stale hash checks, direct filesystem writes, and no-partial-write validation.
- `tree-sitter runtime` depends on WASM grammar assets, runtime WASM, query assets, and build-output asset resolution.
- `get_file_skeleton` depends on tree-sitter runtime and safe source loading.
- `get_function` depends on tree-sitter runtime, skeleton/range lookup patterns, and likely read/edit view integration.
- `symbol index` depends on tree-sitter plus a persistence decision.
- `replace_symbol` and `rename_symbol` depend on symbol/range resolution plus multi-file mutation/reporting strategy.
- `diagnostics_scan` depends on host diagnostics or a deliberate standalone alternative.
- `execute_command` depends on a sandbox/permission policy before any porting work.

## Porting Dependencies

### Hash Anchors

Upstream `AnchorStateManager` stores anchors by task id, assigns randomized dictionary-word anchors, and reconciles unchanged lines through line hashing.

MCP anchor ports should preserve these invariants even if ids differ:

- Anchors are session-scoped.
- Unchanged lines keep anchors when reconciliation can prove continuity.
- Duplicate identical lines remain distinct.
- Stale or ambiguous anchors fail before mutation.
- Edit tools must validate exact current text before writing.

### File Extraction

Upstream `extract-file-content` supports text plus richer formats. Relevant dependency families include binary detection, PDF parsing, DOCX extraction, image metadata, notebooks, and spreadsheets.

MCP ports should not partially implement rich extraction without packaged dependencies and fixtures. Unsupported rich/binary types should fail explicitly until covered.

### Tree-Sitter

Relevant upstream packages include `web-tree-sitter`, grammar WASM assets, and query files under `src/services/tree-sitter/queries`.

Standalone MCP packaging needs source/test and built-output asset resolution. Built output must not accidentally work only because source files or `node_modules` are reachable from cwd.

Known compatibility point: `web-tree-sitter@0.22.6` works with `tree-sitter-wasms@^0.1.13`; newer `web-tree-sitter@0.26` failed to load those grammar binaries during this port.

### Get Function

Upstream `get_function` schema takes `paths` and `function_names`. The handler also accepts a legacy singular `path` internally, resolves each path through the workspace resolver, and delegates AST extraction to `ASTAnchorBridge.getFunctions`.

`ASTAnchorBridge.getFunctions` matches requested names against dot-normalized qualified names and also accepts suffix matches. It formats each result as `relPath::fullName`, includes a function hash, emits edit anchors by default, and separates multiple functions with `---`. It also compares the current function hash with previous conversation history to suppress unchanged repeated output. The standalone MCP port intentionally does not depend on conversation history and keeps edit anchors behind an explicit `view: "edit"`.

Standalone MCP divergence after review: no-match and ambiguous suffix results are structured non-error outcomes; `function_names` is the canonical public input; exact matches are preferred before suffix matches; TypeScript overload signatures are collapsed to an implementation when one is present; `bodyHash` and `viewHash` are separate; full structured output omits source text unless explicitly requested.

### Symbol Index

Upstream symbol index code uses SQLite WASM and `.dirac-symbol-index/data.db`. A standalone MCP server needs an explicit persistence decision before references or rename tools:

- persistent workspace index,
- session-scoped index,
- or no index until a consumer requires it.

### Editing

`EditExecutor` is the best upstream pure-logic reference. It resolves anchors, validates line text, rejects invalid ranges, and applies sorted edits bottom-to-top.

`BatchProcessor` is less directly portable because it mixes pure edits with approval UI, VS Code diff saving, diagnostics, dirty document mediation, and file tracking.

Standalone mutation tools need direct filesystem writes, deterministic diff/report output, and explicit validation failures.

### Ignore Rules

Upstream list/search integrate gitignore and/or `DiracIgnoreController`. MCP ports should decide separately whether `.diracignore` is worth adding. Workspace-root containment is not a semantic replacement for ignore files.

### Ripgrep

Upstream finds a bundled/known `rg` through `getBinaryLocation("rg")`. A standalone MCP server can use system `rg`, but packaging/licensing should be documented before bundling a binary.

## Environment Differences vs Dirac

- MCP stdio server instead of VS Code extension runtime.
- No approval UI, webview, provider/auth flow, telemetry, or task UI callbacks.
- No VS Code diff provider or dirty-document mediation.
- No implicit workspace service; workspace roots must be explicit.
- No long-lived task object; session state must be deliberately scoped and cleaned up.
- ESM NodeNext runtime with explicit import specifiers.
- Generated build output must stay outside git.
- Errors should be concise MCP tool errors with optional structured metadata, not UI messages.

## Suggested Build Order

1. Maintain current filesystem/search/read/edit/skeleton tools; avoid reworking them without a verified bug.
2. Port `get_function` using the existing JS/TS tree-sitter runtime and skeleton extraction patterns.
3. Consider edit workflow extensions only after `get_function` clarifies targeted range/edit needs.
4. Decide symbol index persistence before porting references or rename tools.
5. Add more tree-sitter languages only with grammar assets, query assets, source tests, built smoke, and real-repo coverage.
6. Consider rich file extraction only with packaged dependencies and fixtures.
7. Consider `execute_command` only after a sandbox/permission model exists.

## Known Upstream Pitfalls

- Dirac handlers are not pure library functions; most assume `TaskConfig` and host services.
- Upstream anchor strings and MCP anchor ids need not match, but edit safety invariants must match.
- AST anchor bridge behavior assumes upstream parser/query/index semantics and may not map directly to compact MCP output views.
- Tree-sitter asset resolution can pass in source mode and fail from built `dist`; always smoke built output after parser/runtime changes.
- Query captures can be useful without being full upstream parity. Do not claim language support without fixtures and real file smoke.
- Multi-file editing in upstream relies on host approval/diff behavior. A headless MCP port needs its own transaction/reporting design.
- Symbol rename/reference tools may look easy from handlers but hide index persistence and cross-file correctness decisions.
- Diagnostics are host-heavy; do not port them by stubbing UI diagnostics.
- Command execution is powerful and risky; do not expose it as a convenience port.
