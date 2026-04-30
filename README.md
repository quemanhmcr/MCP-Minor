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

`search_files` requires `rg` (ripgrep) on `PATH`.

Run the server over stdio:

```powershell
npm run dev
```

The server resolves tool paths relative to `DIRAC_MCP_CWD` when set, otherwise `process.cwd()`. Workspace access is restricted to `DIRAC_MCP_WORKSPACE_ROOTS`, a `path.delimiter`-separated list; when unset, it defaults to the cwd.

Example:

```powershell
$env:DIRAC_MCP_CWD = "C:\work\repo"
$env:DIRAC_MCP_WORKSPACE_ROOTS = "C:\work\repo"
npm run dev
```

## Tools

- `list_files`: read-only listing for one or more files/directories. Input: `paths: string[]`, optional `recursive`, optional `limit`. Oversized limits are clamped by the server. Results include absolute `path`, `type`, and stable workspace-relative `relativePath`. Generated directories such as `node_modules`, `dist`, `coverage`, and `.git` are skipped, including submodule-style `.git` files. Other dotfiles and hidden directories remain visible to support explicit codebase inspection. Symlinks are not followed.
- `read_file`: read-only text/code file reader for one or more files. Input: `paths: string[]`, optional `startLine`/`endLine`, Dirac-compatible `start_line`/`end_line`, and optional `lineLimit`. Results include absolute `path`, stable `relativePath`, file hash, `editFileCompatibility`, total line count, line-numbered content, per-line anchors, and truncation flags. Full-file reads over 50KB are rejected unless a line range is supplied. Symlinks, directories, missing files, out-of-workspace paths, binary-looking files, and rich/binary types such as PDF, DOCX, XLSX, and images are rejected with concise MCP errors.
- `search_files`: read-only Rust-regex search using system `rg`. Input: `paths: string[]`, `regex: string`, optional `filePattern`, optional `contextLines`, optional `limit`. Results include absolute `path`, stable `relativePath`, `line`, optional `column`, matched text, and optional bounded preview context. Generated directories such as `node_modules`, `dist`, `coverage`, and `.git` are skipped, as are dotfiles and hidden directories, including when targeted explicitly. Symlinks are not followed by default ripgrep traversal.
- `edit_file`: single-file anchored text/code replacement. Input: `path: string`, `edits: { anchor, oldText, newText }[]`. Call `read_file` first in the same MCP session and use the returned per-line `anchor` plus exact current `oldText`. The anchor identifies the start line only; the replacement span is the number of logical lines in `oldText`. `oldText` must match exactly at that start line after newline normalization, or the call is rejected. Multiple edits in the same file are allowed only when their resolved `oldText` spans do not overlap. The server validates the current file hash and every edit before writing, applies edits bottom-to-top, writes the file once, refreshes anchor state and the stored file hash after success, and returns stable structured output with `path`, `relativePath`, `changed: true`, `editsApplied`, before/after file hashes, detected line ending, per-edit line summary, and a deterministic patch summary.
- `get_file_skeleton`: read-only AST-backed structural outline for JavaScript and TypeScript-family source files. Input: `paths: string[]`, optional `limit`. Supported extensions are `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, and `.tsx`. Results include absolute `path`, stable `relativePath`, `language`, `rootType`, `sourceLength`, `locationEncoding`, `hasParseErrors`, `entryCount`, `limit`, `truncated`, and nested `entries` with stable `id`, `kind`, `name`, `qualifiedName`, `signature`, `signatureTruncated`, line/byte `location`, `containsParseErrors`, and `children`. It preserves imports, export-only statements, exported definitions, anonymous default exports, top-level functions/classes, constructors, class/interface methods, named arrow/function expressions, TypeScript interfaces/types/enums, duplicate names in different scopes, and practical nested members. Missing paths, directories, symlinks, out-of-workspace paths, unsupported extensions, rich/binary files, invalid UTF-8, binary-looking files, and files over the 1MB parse safety cap fail before parsing.

Shared parser foundation:

- Tree-sitter runtime/assets power `get_file_skeleton` and are ready for `get_function`. `npm run build` copies `web-tree-sitter` runtime WASM, JS/TS/TSX grammar WASM, and MCP-owned JS/TS query assets into `dist/tree-sitter/assets/` so built output can parse.

Production caveats for the current tools:

- `.diracignore` is not implemented in the standalone MCP server yet; access is constrained by configured workspace roots plus the built-in skips above.
- `read_file` anchors are deterministic and scoped by `DIRAC_MCP_SESSION_ID`. Anchor state is in memory only and does not survive server restart, process replacement, explicit test resets, or session-id changes. The server hashes each line with FNV-1a, reconciles the previous and current line-hash sequences with an ordered LCS-style match, preserves anchors only for matched unchanged lines, and gives inserted, edited, deleted/reappearing, or unmatched moved lines fresh anchors. Duplicate identical lines keep separate anchors and are matched in the best ordered sequence. This intentionally differs from Dirac's random dictionary-word anchor generation while preserving the anchor validation contract used by `edit_file`.
- `read_file` currently supports UTF-8 text/code files only. Dirac's PDF, DOCX, XLSX, notebook, and image extraction paths are deferred until they can be packaged and tested cleanly in the standalone MCP server.
- `read_file` may inspect files larger than `edit_file` can mutate when a line range is supplied. Each file result includes `editFileCompatibility: { editable, maxBytes, reason? }`, and formatted text includes an edit warning when a file exceeds the 1MB edit mutation cap.
- `search_files` uses ripgrep JSON output. `column` is the 1-based ripgrep byte column, and multiple regex submatches on the same line are represented by the first submatch only.
- `search_files.limit` is a global MCP result limit after parsing. The server also passes `--max-count` to ripgrep as a per-file safety bound and caps captured stdout to avoid unbounded memory use.
- `edit_file` intentionally differs from upstream Dirac. Dirac accepts multi-file batches, `replace`/`insert_before`/`insert_after`, full `Anchor§line_text` start/end anchors, approval UI, VS Code diff saving, diagnostics, and auto-format feedback. This MCP port exposes only one file per call and replace semantics through `{ anchor, oldText, newText }`. Insertions are represented as replacements with suitable `oldText`, and empty `newText` deletes the exact old span. It does not implement UI approval, diagnostics, checkpoints, webviews, auto-format mediation, or multi-file edits.
- `edit_file` requires a successful same-session `read_file` for the target file before editing. If anchor state is missing because the server restarted, the process reset, or the session id changed, `edit_file` rejects with an instruction to call `read_file` again.
- `edit_file` stores the normalized full-file hash from the last `read_file` or successful `edit_file` anchor refresh. Before applying any edit, it recomputes the current normalized full-file hash and rejects if it differs, even when the line count is unchanged and even if the requested `oldText` still matches at its anchor. Call `read_file` again after any external or cross-session file change.
- `edit_file` line-ending behavior is deterministic but conservative: input `oldText` and `newText` normalize CRLF/CR to LF for logical line comparison; the saved file uses the existing dominant line ending, preserving CRLF when the file is CRLF-dominant and LF otherwise. Existing final newline presence is preserved.
- `edit_file` has a no-partial-write guarantee for validation failures: missing anchor state, stale file-hash mismatch, unknown anchors, stale line counts, `oldText` mismatch, overlapping spans, missing paths, directories, symlinks, out-of-workspace paths, binary-looking files, unsupported rich/binary extensions, and oversized files all fail before any write.
- `edit_file` has a conservative 1MB edit mutation cap. This is intentionally tighter than `read_file`'s 20MB hard read cap because `edit_file` performs direct filesystem mutation and holds the full normalized before/after text while validating atomic writes. Oversized-file errors explicitly state that ranged `read_file` inspection can succeed even when `edit_file` mutation is unavailable.
- `get_file_skeleton` intentionally returns structured JSON instead of Dirac's formatted text skeleton. Entry `id` values are stable identifiers for skeleton output, not edit anchors; line/byte locations are non-edit metadata. Use `read_file` when edit-compatible anchors are needed. Locations use tree-sitter UTF-8 byte offsets against the raw file text. It does not compute Dirac's optional call graph comments, does not integrate `.diracignore`, and currently supports only the JS/TS language family packaged in this server. Parser recovery is surfaced through file-level `hasParseErrors` and entry-level `containsParseErrors` instead of hiding syntax problems.

## Git Hygiene

- Use focused branches, for example `setup/mcp-scaffold` or `tool/list-files`.
- Keep commits scoped to one setup step, tool, or shared dependency.
- Treat `dirac/` as read-only upstream source material. Do not edit files inside the submodule during MCP porting sessions.
- Keep generated artifacts out of commits: `node_modules/`, `dist/`, `coverage/`, logs, local env files, and runtime indexes are ignored.
- Commit `mcp-server/package-lock.json` with package changes so future sessions are reproducible.
