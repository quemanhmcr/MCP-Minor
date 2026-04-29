# Dirac Codebase Tools MCP Porting Tracker

Operational source of truth for the standalone MCP port. Keep this file optimized for quickly resuming work.

## Current Project Status

- Goal: build a standalone MCP server for selected Dirac codebase-working tools only.
- Runtime package: `mcp-server/`, Node.js >= 20.11, ESM TypeScript, npm with committed `package-lock.json`.
- Transport: MCP stdio first. Do not add HTTP/SSE until a real consumer needs it.
- Upstream source: `dirac/` is a pinned git submodule and read-only source material.
- Pinned Dirac commit: `e827ec30d4cdae078588df2040f203b780d657ad`.
- Current production-ready MCP tools: `list_files`, `read_file`, `search_files`.
- No tree-sitter tools, symbol index, editing tools, or command execution are implemented.
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
- Returns structured `{ files, lineLimit, truncated }`, where each file includes absolute `path`, slash-stable `relativePath`, `fileHash`, `totalLines`, `startLine`, `endLine`, per-line `{ line, anchor, text, formatted }`, line-numbered `content`, `anchorDelimiter`, and `truncated`.
- Generates deterministic session-scoped anchors using `RuntimeContext.sessionId`, normalized absolute path, line hashes, and in-memory reconciliation. Repeated same-content reads in the same session keep anchors; changed lines get new anchors; unchanged lines are preserved when possible.
- Uses Dirac's FNV-1a content hash shape for `[File Hash: ...]`.
- Rejects full-file reads over 50KB unless a line range is supplied, with a hard 20MB read cap and bounded line/output caps.
- Rejects missing paths, out-of-workspace paths, directories, symlinks, symlink escapes, binary-looking files, invalid UTF-8, and unsupported rich/binary extensions with concise MCP errors.

Dirac parity:

- Parity accurate for multi-path schema, one-based inclusive line ranges, full-read 50KB safety behavior, FNV-1a file hashes, hash-anchored lines, and session-scoped anchor lifecycle intent.
- Intentionally different from Dirac: output is structured MCP JSON plus line-numbered text; anchor IDs are deterministic `Axxxxxxxx` hashes instead of random dictionary words; no repeated-read "no changes have been made" elision from conversation history; no approval UI, telemetry, file context tracker, `.diracignore`, image blocks, or PDF/DOCX/IPYNB/XLSX extraction.

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
| `read_file` | `done` | P0 | Production-ready under MCP text-file scope | Multi-path text reads, line ranges, FNV file hashes, deterministic session-scoped anchors, workspace safety, output caps, and MCP tests. Intentional differences: structured/line-numbered output, deterministic hash anchors, rich file extraction deferred. | Maintain; use anchors as the baseline for later edit design. |
| `get_file_skeleton` | `not_started` | P1 | Not available | Requires tree-sitter WASM packaging, queries, and likely anchor support. | Start after `read_file`. |
| `get_function` | `not_started` | P1 | Not available | Requires tree-sitter and anchors via `ASTAnchorBridge`. | Start after skeleton/anchors. |
| `edit_file` | `not_started` | P1 | Not available | High value but higher risk. Needs headless replacement for diff view, approvals, diagnostics, and dirty-file handling. | Start only after anchors are stable. |
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
- `.diracignore` support is deferred. Current protection is workspace-root containment plus built-in generated/hidden skips per tool.
- `search_files` depends on system `rg` being available on `PATH`. Do not silently add a bundled binary without documenting packaging and licensing implications.

## Known Residual Risks

- `.diracignore` is not implemented, so ignore behavior is not full Dirac parity.
- `read_file` supports text/code files only. PDF, DOCX, XLSX, notebook, and image extraction are intentionally deferred until the standalone server has packaged dependencies and verification fixtures.
- `read_file` anchors are suitable for later edit validation within the same server process/session, but no edit tool consumes them yet.
- `search_files` uses system `rg`; environments without ripgrep get a clear error but cannot search.
- `search_files` structured output lacks Dirac's formatted hash-anchored lines.
- `list_files` intentionally differs from Dirac by not returning line counts or mtimes.
- Tree-sitter tools will require WASM asset packaging and query compatibility checks.
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

1. Prepare tree-sitter asset strategy.
   - Verify `web-tree-sitter`, `tree-sitter-wasms`, query files, and package output layout.
   - Do this before `get_file_skeleton` or `get_function`.

2. Design `edit_file` around current MCP anchors.
   - Consume `read_file` anchors by `RuntimeContext.sessionId`.
   - Define direct-write, diff output, stale-anchor, and dirty-file behavior before implementation.

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
