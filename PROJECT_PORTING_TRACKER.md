# Dirac Codebase Tools MCP Porting Tracker

Operational source of truth for the standalone MCP port. Keep this file optimized for quickly resuming work.

## Current Project Status

- Goal: build a standalone MCP server for selected Dirac codebase-working tools only.
- Runtime package: `mcp-server/`, Node.js >= 20.11, ESM TypeScript, npm with committed `package-lock.json`.
- Transport: MCP stdio first. Do not add HTTP/SSE until a real consumer needs it.
- Upstream source: `dirac/` is a pinned git submodule and read-only source material.
- Pinned Dirac commit: `e827ec30d4cdae078588df2040f203b780d657ad`.
- Current production-ready MCP tools: `list_files`, `read_file`, `search_files`, `edit_file`, `get_file_skeleton`.
- Shared tree-sitter runtime/asset foundation is implemented and verified, and `get_file_skeleton` is the first AST-backed MCP tool on top of it.
- No `get_function`, symbol index, multi-file editing tools, or command execution are implemented.
- Generated artifacts must stay out of git. In particular, remove `mcp-server/dist/` after any build.

## Production-Ready Tools

### `list_files`

Status: production-ready under current MCP scope.

- MCP callable through `McpServer.registerTool`.
- Read-only, idempotent, workspace-root guarded.
- Accepts `paths`, optional `recursive`, optional `limit`.
- Returns structured `{ entries, limit, truncated }` with entries shaped as `{ path, type, relativePath }`.
- Deterministic sort by entry name within each listed directory.
- Skips generated/heavy directories: `node_modules`, `dist`, `coverage`, `.git`; also skips submodule-style `.git` files.
- Does not follow symlinks.
- Defensively validates direct handler calls, clamps oversized limits, deduplicates overlapping inputs, and fails fast on missing paths.

Dirac parity:

- Parity accurate for the core read-only listing purpose and generated directory skips.
- Intentionally different from Dirac: output is structured MCP JSON, not Dirac UI text; no line counts or mtimes; no globby/gitignore integration; no home/root special case beyond workspace-root containment; non-git hidden files and hidden directories remain visible.

### `search_files`

Status: production-ready under current MCP scope.

- MCP callable through `McpServer.registerTool`.
- Read-only, idempotent, workspace-root guarded.
- Accepts `paths`, `regex`, optional `filePattern`, optional `contextLines`, optional `limit`.
- Uses system `rg` via `child_process.spawn` with an args array, not shell string composition.
- Returns structured `{ matches, limit, truncated }` with matches shaped as `{ path, relativePath, line, column?, match, preview? }`.
- Skips dotfiles, hidden directories, `node_modules`, `dist`, `coverage`, and `.git`, including when dot/hidden paths are targeted explicitly.
- Caps captured ripgrep stdout before parsing and passes `--max-count` using the clamped MCP limit.
- Surfaces missing-ripgrep and invalid-regex failures as concise MCP tool errors without stack traces.

Dirac parity:

- Parity accurate for Dirac's core `rg --json` search approach, Rust regex behavior, hidden-path exclusion, generated-directory exclusion, context line clamp, first-submatch-only same-line behavior, and byte-column behavior.
- Intentionally different from Dirac: output is structured MCP JSON instead of anchored formatted text; no `AnchorStateManager` integration; no `.diracignore` controller; no bundled `rg` lookup.

Current caveats:

- `column` is ripgrep's 1-based byte column.
- Multiple regex submatches on the same line produce one MCP match entry using ripgrep's first submatch, matching Dirac's parsed-output behavior.
- `limit` is the global MCP result limit after parsing. `--max-count` is also used as a per-file safety bound.

### `read_file`

Status: production-ready under current standalone MCP text-file scope.

- MCP callable through `McpServer.registerTool`.
- Read-only, idempotent, workspace-root guarded.
- Accepts `paths`, optional `startLine`/`endLine`, Dirac-compatible `start_line`/`end_line`, and optional `lineLimit`.
- Returns structured `{ files, lineLimit, truncated }`, where each file includes absolute `path`, slash-stable `relativePath`, `fileHash`, `editFileCompatibility`, `totalLines`, `startLine`, `endLine`, per-line `{ line, anchor, text, formatted }`, line-numbered `content`, `anchorDelimiter`, and `truncated`.
- Generates deterministic session-scoped anchors using `RuntimeContext.sessionId`, normalized absolute path, line hashes, and in-memory reconciliation. Repeated same-content reads in the same session keep anchors. Reconciliation uses an ordered LCS-style match over FNV-1a line hashes, with prefix/suffix fast paths and a bounded greedy fallback for very large middles; matched unchanged lines keep anchors, while inserted, edited, deleted/reappearing, or unmatched moved lines get new anchors.
- Keeps duplicate identical lines as distinct anchors. Duplicate lines are preserved by ordered matching, so insertion/deletion around duplicates keeps the best matching existing anchors without assigning one anchor to two current lines.
- Uses Dirac's FNV-1a content hash shape for `[File Hash: ...]`.
- Reports `editFileCompatibility: { editable, maxBytes, reason? }` for each file and adds a formatted warning when ranged reads inspect files larger than the 1MB `edit_file` mutation cap.
- Rejects full-file reads over 50KB unless a line range is supplied, with a hard 20MB read cap and bounded line/output caps.
- Rejects missing paths, out-of-workspace paths, directories, symlinks, symlink escapes, binary-looking files, invalid UTF-8, and unsupported rich/binary extensions with concise MCP errors.

Dirac parity:

- Parity accurate for multi-path schema, one-based inclusive line ranges, full-read 50KB safety behavior, FNV-1a file hashes, hash-anchored lines, and session-scoped anchor lifecycle intent.
- Intentionally different from Dirac: output is structured MCP JSON plus line-numbered text; anchor IDs are deterministic `Axxxxxxxx` hashes instead of random dictionary words; pure reorder/move handling is conservative and only preserves the ordered unchanged subsequence; no repeated-read "no changes have been made" elision from conversation history; no approval UI, telemetry, file context tracker, `.diracignore`, image blocks, or PDF/DOCX/IPYNB/XLSX extraction.

### `edit_file`

Status: production-ready under current MCP single-file text/code scope.

- MCP callable through `McpServer.registerTool`.
- Mutating, workspace-root guarded, single file per call.
- Accepts `path` and `edits: { anchor, oldText, newText }[]`.
- Requires existing same-session anchor state from `read_file`.
- Anchor state is in-memory and session-scoped. It does not survive server restart/reset/session changes; missing anchor state produces a concise instruction to call `read_file` again.
- Stores the normalized full-file hash from the last `read_file` or successful `edit_file` anchor refresh. Before any write, rejects if the current normalized full-file hash differs, including same-line-count external or cross-session changes.
- Anchor identifies the start line only. The edit span is exactly the logical line count in `oldText`, starting at that anchor.
- `oldText` and `newText` normalize CRLF/CR to LF for validation and replacement. `oldText` must exactly match the current file lines at the resolved span; there is no fuzzy match, fallback search, or unanchored replacement.
- Computes all ranges before writing, rejects overlaps, then applies validated edits bottom-to-top and writes once. Unknown anchors, stale line counts, oldText mismatches, overlap, path errors, symlinks, binary-looking files, unsupported rich/binary extensions, and oversized files fail before any write.
- Preserves the existing final newline state and writes with the existing dominant line ending (`crlf` for CRLF-dominant files, otherwise `lf`).
- Refreshes anchor state and the stored file hash after a successful write so subsequent same-session reads/edits use updated content.
- Uses a documented 1MB edit mutation cap, intentionally tighter than `read_file`'s 20MB hard read cap. Oversized-file errors explicitly explain that ranged `read_file` inspection may still work even though `edit_file` mutation is unavailable.
- Returns structured `{ path, relativePath, changed: true, editsApplied, fileHashBefore, fileHashAfter, lineEnding, appliedEdits, diff }`; `diff` is a deterministic patch summary using `*** Update File`, `@@ start,oldCount -> newCount @@`, `-old`, and `+new` lines.

Dirac parity:

- Parity accurate for anchor-first editing, exact anchor text validation intent, non-overlap rejection, bottom-to-top application, and anchor state refresh after write.
- Intentionally different from Dirac: single file only, replace-only MCP schema, start anchor plus exact `oldText` instead of Dirac's full `Anchor§line_text` start/end anchors, no `insert_before`/`insert_after`, no multi-file batching, no approval UI, no VS Code diff provider, no diagnostics, no auto-format/user-edit feedback, no telemetry, and structured MCP JSON instead of Dirac UI text.

### `get_file_skeleton`

Status: production-ready under current MCP JS/TS AST scope.

- MCP callable through `McpServer.registerTool`.
- Read-only, idempotent, workspace-root guarded.
- Accepts `paths` and optional `limit`; supported extensions are `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, and `.tsx`.
- Reuses `src/tree-sitter/runtime.ts`; no second parser/runtime path.
- Rejects unsupported extensions, missing paths, directories, symlinks, symlink escapes, out-of-workspace paths, rich/binary extensions, binary-looking files, invalid UTF-8, and files over the 1MB parse safety cap before parsing.
- Returns structured `{ files, limit, truncated }`; each file includes absolute `path`, stable `relativePath`, `language`, `rootType`, `sourceLength`, `locationEncoding`, `hasParseErrors`, `entryCount`, per-file `limit`, per-file `truncated`, and nested skeleton `entries`.
- Skeleton entries are shaped as `{ id, kind, name, qualifiedName, signature, signatureTruncated, location, containsParseErrors, children }`, with one-based line ranges and tree-sitter UTF-8 byte offsets against raw file text.
- Preserves imports, export-only statements, exported definitions, anonymous default exports, top-level functions/classes, JS/TS constructors, class/interface methods, named arrow/function expressions including multiple declarators, TypeScript interfaces/types/enums, duplicate names in different scopes, and practical nested members.
- Signature extraction uses tree-sitter `body` fields first so nested callback/default-parameter/heritable expression bodies do not truncate declaration signatures. A DFS fallback remains for unusual grammar nodes without a `body` field.
- Parse recovery is explicit through file-level `hasParseErrors` and entry-level `containsParseErrors`; syntax-error fixtures are covered.
- Entry `id` values are stable skeleton identifiers, not edit anchors. Locations are non-edit metadata. Use `read_file` to obtain edit-compatible anchors.

Dirac parity:

- Parity accurate for the core purpose of extracting a structural outline from tree-sitter captures, including nested definitions and JS/TS family support.
- Intentionally different from Dirac: output is structured MCP JSON instead of Dirac's formatted anchored text; no `AnchorStateManager` integration; no call graph comments; no `.diracignore`; no approval UI/telemetry; JS/TS-family only for now.

Real pinned Dirac smoke:

- `dirac/src/services/tree-sitter/languageParser.ts`: TypeScript `program`, 5333 chars, no parse errors, 9 skeleton entries. Expected entries include `interface LanguageParser`, `function loadLanguage`, `function initializeParser`, and `function loadRequiredLanguageParsers`.
- `dirac/src/core/task/tools/handlers/GetFileSkeletonToolHandler.ts`: TypeScript `program`, 7192 chars, no parse errors, 20 skeleton entries. Expected entries include `class GetFileSkeletonToolHandler`, `method constructor`, `method getDescription`, `method handlePartialBlock`, and `method execute`.
- `dirac/scripts/file-utils.mjs`: JavaScript `program`, 766 chars, no parse errors, 5 skeleton entries. Expected entries include `function writeFileWithMkdirs`, `function rmrf`, and `function rmdir`.

Current caveats:

- Imports and export-only statements are top-level structural entries; exported declarations are represented by the exported definition signature rather than a separate wrapper entry.
- `limit` truncates entries in preorder and preserves deterministic shape, but very large files still fail at the 1MB parse safety cap.
- Constructor handling is now consistent for JS and TS: constructors appear as method entries nested under their class.
- Import and re-export sub-kinds remain conservative; richer `import:type`, namespace import, and re-export classification can be added later without changing the core entry model.

## Shared Tree-Sitter Runtime

Status: production-ready shared foundation for `get_file_skeleton` and future `get_function` ports.

- Internal API: `src/tree-sitter/runtime.ts`.
- Supported initial language set: JavaScript-family `.js`, `.jsx`, `.mjs`, `.cjs`; TypeScript-family `.ts`, `.tsx`.
- Dependencies: exact `web-tree-sitter@0.22.6` and `tree-sitter-wasms@^0.1.13`. `web-tree-sitter` is pinned to the upstream Dirac-compatible 0.22.6 release because 0.26 could not load the `tree-sitter-wasms@0.1.13` grammar binaries.
- Query assets: MCP-owned `.scm` files in `src/tree-sitter/queries/` for JavaScript and TypeScript. They are copied to `dist/tree-sitter/assets/queries/` during `npm run build`.
- WASM assets: build copies `node_modules/web-tree-sitter/tree-sitter.wasm` plus `tree-sitter-javascript.wasm`, `tree-sitter-typescript.wasm`, and `tree-sitter-tsx.wasm` from `tree-sitter-wasms/out/` into `dist/tree-sitter/assets/wasm/`.
- Asset resolution is Windows-safe and uses `import.meta.url`/`fileURLToPath`, `createRequire(import.meta.url)`, `path.join`, and explicit candidate roots. It does not depend on process cwd. Source/test execution resolves source queries plus package WASM fallback; built execution can run with `includeNodeModulesFallback: false` and resolve only from `dist`.
- Parser API returns typed parse results with language handle, query, tree, root node type, source length, asset paths, parse-error flag, and `dispose()` for tree cleanup. It deliberately does not expose the mutable `Parser` instance. Unsupported extensions and missing/init/language/query/parse failures produce explicit `TreeSitterRuntimeError` codes and concise messages.
- Built-output smoke script: `dist/tree-sitter/smoke.js` after `npm run build`; it imports built JS, parses supplied files using only copied `dist` assets for the parser smoke, and runs `get_file_skeleton` from built output.

Current caveats:

- Query assets are intentionally minimal compatibility queries for the initial JS/TS foundation. Full Dirac query parity for all upstream languages remains future work.
- AST skeleton extraction is ported through `get_file_skeleton`. AST anchor formatting, function lookup, symbol range lookup, and symbol index remain unported.

## Tool Status Table

Status meanings:

- `not_started`: not ported yet.
- `in_progress`: active session started but not complete.
- `blocked`: needs a decision or missing dependency.
- `ported`: implementation exists but verification is incomplete.
- `done`: implemented, callable, verified, and documented.

| Tool | Status | Priority | Production Status | Dirac Parity / Notes | Next Action |
| --- | --- | --- | --- | --- | --- |
| `list_files` | `done` | P0 | Production-ready under MCP scope | Core listing behavior ported. Intentional differences: structured JSON, no line counts/mtimes, no `.diracignore`, hidden non-git paths visible. | Maintain only. |
| `search_files` | `done` | P0 | Production-ready under MCP scope | Core ripgrep behavior ported. Hidden/dot path exclusion, byte columns, and first-submatch behavior documented. Intentional differences: structured JSON, no anchors, no `.diracignore`, system `rg`. | Maintain only. |
| `read_file` | `done` | P0 | Production-ready under MCP text-file scope | Multi-path text reads, line ranges, FNV file hashes, edit-file compatibility metadata, deterministic session-scoped anchors, workspace safety, output caps, and MCP tests. Intentional differences: structured/line-numbered output, deterministic hash anchors, rich file extraction deferred. | Maintain; use anchors as the baseline for later edit design. |
| `get_file_skeleton` | `done` | P1 | Production-ready under MCP JS/TS AST scope | Structured AST skeleton extraction ported. Intentional differences: structured JSON, non-edit locations instead of anchors, no call graph comments, no `.diracignore`, JS/TS-family only. | Maintain; use as foundation for `get_function`. |
| `get_function` | `not_started` | P1 | Not available as an MCP tool | Shared tree-sitter runtime/assets and skeleton extraction patterns are ready for JS/TS. Still needs function range/name matching, context/anchors, output schema, and MCP tests. | Start next using `get_file_skeleton` patterns. |
| `edit_file` | `done` | P1 | Production-ready under single-file MCP text/code scope | Anchor-first exact replacement ported and hardened with full-file hash freshness. Intentional differences: single file, replace-only `{ anchor, oldText, newText }`, deterministic diff summary, no Dirac UI/approval/diagnostics/multi-file flow. | Maintain only. |
| `find_symbol_references` | `not_started` | P2 | Not available | Requires symbol index and SQLite WASM or a deliberate alternative. | Defer. |
| `replace_symbol` | `not_started` | P2 | Not available | Requires AST range resolution and mutation flow. | Defer until edit stack exists. |
| `rename_symbol` | `not_started` | P2 | Not available | Requires symbol index and careful multi-file diff/reporting. | Defer. |
| `diagnostics_scan` | `not_started` | P3 | Not available | Dirac version is host/integration-heavy. | Optional later. |
| `execute_command` | `not_started` | P3 | Not available | Powerful and risky. Needs explicit sandbox/permission policy before exposing. | Do not port without policy. |

## Technical Decisions

- Build a new MCP server instead of trying to run Dirac's `ToolExecutor`.
- Reuse or port Dirac's pure logic where possible; replace UI callbacks with MCP responses or MCP errors.
- Remove/no-op telemetry, approval UI, task workflow, webview behavior, provider/auth flow, and VS Code host behavior.
- Keep tool APIs close to Dirac schemas unless MCP has a clear reason to differ.
- Work in `mcp-server/` for implementation. Treat `dirac/` as read-only.
- Use TypeScript `NodeNext`, strict mode, ESM, and explicit `.js` import specifiers.
- Keep server creation separate from stdio startup so tests can instantiate the server with in-memory transports.
- Runtime context is intentionally slim: `cwd`, `sessionId`, `workspaceRoots`.
- Path resolution accepts relative paths against `RuntimeContext.cwd`; absolute paths are allowed only when inside configured workspace roots. Sibling-prefix escapes and traversal are rejected.
- `read_file` additionally rejects symlinks and verifies real paths stay inside the resolved workspace root before reading.
- Anchor state is in-memory and session-scoped by `RuntimeContext.sessionId`. It is deterministic for reproducibility in tests and MCP sessions, unlike Dirac's randomized dictionary-word anchors.
- `edit_file` consumes existing `read_file` anchor state without reconciling first. It first requires the current normalized full-file hash to match the stored same-session snapshot from the last `read_file` or successful `edit_file`. Hash mismatches are stale and rejected before any write, including same-line-count edits. If the hash matches, the anchor's tracked start line must still contain exact `oldText`.
- `edit_file` uses logical LF text for validation and deterministic diff output, then writes with the file's existing dominant EOL and preserves whether the file ended with a newline.
- `read_file` reports whether each file is currently within the `edit_file` mutation cap so agents can avoid planning an unsupported edit after a successful ranged read.
- `.diracignore` support is deferred. Current protection is workspace-root containment plus built-in generated/hidden skips per tool.
- `search_files` depends on system `rg` being available on `PATH`. Do not silently add a bundled binary without documenting packaging and licensing implications.
- Tree-sitter uses exact `web-tree-sitter@0.22.6` with `tree-sitter-wasms@^0.1.13`, matching upstream Dirac compatibility. Build-time asset copying is explicit through `scripts/copy-tree-sitter-assets.mjs`.
- Built tree-sitter runtime must continue to work without reaching back into `node_modules`; verify with `node dist/tree-sitter/smoke.js <files>` after `npm run build` when changing parser assets/runtime.

## Known Residual Risks

- `.diracignore` is not implemented, so ignore behavior is not full Dirac parity.
- `read_file` supports text/code files only. PDF, DOCX, XLSX, notebook, and image extraction are intentionally deferred until the standalone server has packaged dependencies and verification fixtures.
- `edit_file` rejects any file-hash drift as stale instead of trying to reconcile before applying. This is conservative and may reject safe unrelated edits until the caller rereads the file, but it catches same-line-count external and cross-session changes before mutation.
- `edit_file` supports single-file anchored replacement only. Multi-file batching, insert-specific operations, and end-anchor ranges are intentionally deferred.
- Files larger than 1MB can be inspected with ranged `read_file` but cannot be mutated with `edit_file`; `read_file` reports this through `editFileCompatibility`.
- `read_file` reorder/move preservation is intentionally conservative: ordered unchanged subsequences keep anchors, but lines moved out of order may receive fresh anchors to avoid stale-anchor reuse.
- `search_files` uses system `rg`; environments without ripgrep get a clear error but cannot search.
- `search_files` structured output lacks Dirac's formatted hash-anchored lines.
- `list_files` intentionally differs from Dirac by not returning line counts or mtimes.
- Tree-sitter foundation currently packages JS/TS/TSX WASM and JS/TS query assets only. Additional languages need deliberate query and grammar smoke coverage before exposure.
- `get_file_skeleton` entry ids and locations are not edit anchors. Agents must use `read_file` before `edit_file`.
- `get_file_skeleton` does not compute Dirac call graph comments and does not integrate `.diracignore`.
- Tree-sitter queries are minimal `.scm` compatibility assets and are not yet full upstream Dirac parity across all languages or call-graph captures.
- Editing tools need a headless design for direct writes, diff output, approval policy, diagnostics, and anchor drift.
- Symbol-index tools need a persistence decision for `.dirac-symbol-index` versus session-scoped state.

## Verification Commands

Run from `c:\project\lamviec\dirac-mcp\mcp-server` when changing runtime/source/tests:

```powershell
npm run build
npm run test
npm run lint
npm run typecheck
```

Docs-only sessions do not need the full suite unless they make or verify behavior claims. Always run:

```powershell
git status --short --branch
git submodule status
Test-Path mcp-server/dist
git diff --stat
```

If `npm run build` creates `mcp-server/dist/`, remove it before finishing:

```powershell
Remove-Item -Recurse -Force mcp-server/dist
```

## Next Recommended Sessions

1. Port `get_function`.
   - Reuse the same parser/query runtime and integrate deterministic MCP anchors deliberately.
   - Use the `get_file_skeleton` safety checks, structured output style, real-repo smoke pattern, and built-output smoke path as the baseline.

## Future Sessions Must Avoid

- Do not edit upstream `dirac/` files.
- Do not port more than one tool or one small shared dependency per implementation session.
- Do not add `read_file` or any new tool during documentation-only sessions.
- Do not commit generated artifacts, especially `mcp-server/dist/`.
- Do not expose `execute_command` without a deliberate sandbox/permission policy.
- Do not mark a tool `done` until it is MCP-callable, tested, documented, and verified.
- Do not push unless explicitly asked.

## Session Log

Keep this short. Preserve useful history, but do not turn this tracker into a transcript.

| Date | Session Goal | Status | Verification | Notes |
| --- | --- | --- | --- | --- |
| 2026-04-29 | Clone Dirac and map tool porting strategy | `done` | Manual repo inspection | Confirmed no existing Dirac MCP runtime; chose standalone MCP server. |
| 2026-04-29 | Scaffold MCP server and normalize repo hygiene | `done` | `npm run build`; `npm run test`; `npm run lint`; `npm run typecheck`; git/submodule checks | Created `mcp-server/`, npm TypeScript MCP SDK foundation, root git hygiene, and pinned `dirac/` submodule. No Dirac tool ported. |
| 2026-04-29 | Port and harden `list_files` | `done` | `npm run build`; `npm run test`; `npm run lint`; `npm run typecheck`; MCP in-memory smoke | Added workspace path guard, deterministic listing, generated-directory and `.git` skips, symlink skip, limit validation/clamping, dedupe, concise errors, and MCP smoke coverage. |
| 2026-04-29 | Standardize MCP tool registration/responses | `done` | `npm run build`; `npm run test`; `npm run lint`; `npm run typecheck` | Added `registerTools` and shared structured success/error helpers. No new Dirac tool ported. |
| 2026-04-29 | Port and harden `search_files` | `done` | `npm run build`; `npm run test`; `npm run lint`; `npm run typecheck`; MCP in-memory smoke | Added system-ripgrep search, workspace guarding, hidden/generated path skips, bounded structured output, invalid-regex/missing-rg errors, byte-column and first-submatch caveat tests. |
| 2026-04-29 | Real-repo smoke and parity audit for `list_files` / `search_files` | `done` | `npm run build`; `npm run test`; `npm run lint`; `npm run typecheck`; MCP smoke against `dirac/` | Re-read upstream handlers/core services, confirmed no runtime fixes needed, added parity/edge regression coverage, and fixed submodule-style `.git` listing leak. |
| 2026-04-29 | Consolidate documentation for handoff clarity | `done` | Docs-only git/submodule/dist checks | Reorganized tracker as the operational source of truth and upstream notes as reference material. No code changed and no new Dirac tool ported. |
| 2026-04-29 | Port and harden `read_file` | `done` | `npm run build`; `npm run test`; `npm run lint`; `npm run typecheck`; MCP smoke against `dirac/` | Added text/code reads, line ranges, deterministic session anchors, FNV file hashes, workspace/realpath safety, bounded output, domain/MCP coverage, and explicit rich-file deferrals. Smoke: `README.md` 8ms/13900 chars, handler range 3ms/4979 chars, ripgrep range 2ms/1499 chars, friendly errors for `..`, missing file, and directory. |
| 2026-04-29 | Harden `read_file` anchor reconciliation | `done` | `npm run build`; `npm run test`; `npm run lint`; `npm run typecheck` | Replaced hash-bucket preservation with ordered LCS-style reconciliation, added duplicate/reorder/session/edit-contract tests, documented deterministic anchor behavior and future `edit_file` assumptions. No new tool ported. |
| 2026-04-29 | Port single-file anchored `edit_file` | `done` | `npm run build`; `npm run test`; `npm run lint`; `npm run typecheck`; MCP in-memory smoke | Added `{ path, edits: [{ anchor, oldText, newText }] }`, exact oldText validation, stale/overlap/no-partial-write protection, deterministic diff summary, line-ending preservation, anchor refresh after write, domain/MCP/smoke coverage. No other tool ported. |
| 2026-04-29 | Harden anchored `edit_file` freshness | `done` | `npm run build`; `npm run test`; `npm run lint`; `npm run typecheck` | Added stored full-file hash snapshots to anchor state, stale hash rejection before writes, restart/reset no-anchor coverage, same-line-count external/cross-session tests, documented 1MB edit mutation cap. No new tool ported. |
| 2026-04-29 | Surface edit mutation cap during reads | `done` | `npm run build`; `npm run test`; `npm run lint`; `npm run typecheck` | Added `read_file` edit-file compatibility metadata/warnings for files over the 1MB mutation cap and improved oversized `edit_file` error guidance. No new tool ported. |
| 2026-04-29 | Prepare tree-sitter runtime and assets | `done` | `npm run build`; `npm run test`; `npm run lint`; `npm run typecheck`; built `dist` smoke against pinned Dirac files | Added exact `web-tree-sitter@0.22.6`, `tree-sitter-wasms@^0.1.13`, MCP-owned JS/TS `.scm` queries, build asset copy script, reusable parser runtime, parser tests, and built-output smoke. Smoke: `dirac/src/services/tree-sitter/languageParser.ts` TypeScript `program`, 5333 chars, no parse errors; `dirac/scripts/file-utils.mjs` JavaScript `program`, 766 chars, no parse errors; all assets loaded from `dist`. No MCP tree-sitter tool ported. Follow-up hardening removed cwd-relative package lookup, removed empty asset-root trick, added process-global init guard, simplified query cache keys, stopped exposing mutable parser instances, and added tree disposal/test coverage. |
| 2026-04-29 | Port AST-backed `get_file_skeleton` | `done` | `npm run build`; `npm run test`; `npm run lint`; `npm run typecheck`; built `dist` smoke against pinned Dirac files | Added safe file loading, structured skeleton extraction, MCP registration, hard fixture tests, MCP in-memory smoke, real Dirac repo smoke, and docs. Follow-up hardening added stable entry ids, qualified names, anonymous default exports, JS/TS constructor parity, body-field signature extraction, raw UTF-8 byte offsets, signature truncation flags, and per-entry parse-error metadata. Real smoke: `languageParser.ts` 5333 chars/9 entries/no parse errors; `GetFileSkeletonToolHandler.ts` 7192 chars/20 entries/no parse errors; `file-utils.mjs` 766 chars/5 entries/no parse errors. Locations are non-edit metadata; use `read_file` for anchors. |

## Session Completion Template

```text
Session:
Tool/dependency:
Status: not_started | in_progress | blocked | ported | done
Files changed:
Tests/verification:
Remaining work:
Next recommended session:
```
