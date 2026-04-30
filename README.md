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

Tools use a task-oriented `view` option for token control. Full JSON remains available with `view: "full"`. The older `format: "compact" | "json"` option remains as a compatibility alias: `compact` maps to the default compact view and `json` maps to `view: "full"`.

- `list_files`: read-only listing for one or more files/directories. Input: `paths: string[]`, optional `recursive`, optional `limit`, optional `view: "outline" | "full"`. Outline output is a newline list with `f`/`d` markers and workspace-relative paths; full output includes absolute `path`, `type`, and stable `relativePath`. Generated directories such as `node_modules`, `dist`, `coverage`, and `.git` are skipped, including submodule-style `.git` files. Other dotfiles and hidden directories remain visible to support explicit codebase inspection. Symlinks are not followed.
- `read_file`: read-only text/code file reader for one or more files. Input: `paths: string[]`, optional `startLine`/`endLine`, Dirac-compatible `start_line`/`end_line`, optional `lineLimit`, optional `view: "read" | "edit" | "full"`, optional `includeAnchors`. Default `read` output is line-numbered text without anchors. `edit` output includes anchors in text and marks the file edit-ready for `edit_file`. `full` includes absolute `path`, file hash, `editFileCompatibility`, total line count, line-numbered content, per-line `{ line, anchor, text, formatted }`, and truncation flags. Full-file reads over 50KB are rejected unless a line range is supplied.
- `search_files`: read-only Rust-regex search using system `rg`. Input: `paths: string[]`, `regex: string`, optional `filePattern`, optional `contextLines`, optional `limit`, optional `view: "matches" | "files" | "full"`, optional `includeColumn`. `matches` output is grep-like and omits byte columns by default; `files` groups high match counts by file and line numbers; `full` includes absolute paths, byte columns, matched text, and optional preview context. Generated directories, dotfiles, and hidden directories are skipped as before.
- `edit_file`: single-file anchored text/code replacement. Input: `path: string`, `edits: { anchor, oldText, newText }[]`, optional `view: "summary" | "full"`. Call `read_file` with `view: "edit"` first in the same MCP session. Summary output reports `edit: path | applied N | hash before->after` plus tight `@Lx -m +n` edit lines; full output includes absolute `path`, `relativePath`, `changed: true`, `editsApplied`, before/after file hashes, detected line ending, per-edit line summary, and deterministic patch summary.
- `get_file_skeleton`: read-only AST-backed structural outline for JavaScript and TypeScript-family source files. Input: `paths: string[]`, optional `limit`, optional `view: "outline" | "signatures" | "full"`, optional `includeImports`, optional `maxSignatureChars`. `outline` omits signatures for cheapest navigation. `signatures` is the default and adds grouped imports/exports and bounded signatures. Full output includes absolute `path`, stable `relativePath`, `language`, `rootType`, `sourceLength`, `sourceLineCount`, `locationEncoding`, `hasParseErrors`, `entryCount`, `limit`, `truncated`, and nested entries with stable `id`, line/byte `location`, `containsParseErrors`, and `children`. Supported extensions are `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, and `.tsx`.

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
- `edit_file` requires a successful same-session `read_file` with `view: "edit"` for the target file before editing. A default `read` view records freshness but is not edit-ready, so `edit_file` rejects with an instruction to reread using `view: "edit"`.
- `edit_file` stores the normalized full-file hash from the last `read_file` or successful `edit_file` anchor refresh. Before applying any edit, it recomputes the current normalized full-file hash and rejects if it differs, even when the line count is unchanged and even if the requested `oldText` still matches at its anchor. Call `read_file` again after any external or cross-session file change.
- `edit_file` line-ending behavior is deterministic but conservative: input `oldText` and `newText` normalize CRLF/CR to LF for logical line comparison; the saved file uses the existing dominant line ending, preserving CRLF when the file is CRLF-dominant and LF otherwise. Existing final newline presence is preserved.
- `edit_file` has a no-partial-write guarantee for validation failures: missing anchor state, stale file-hash mismatch, unknown anchors, stale line counts, `oldText` mismatch, overlapping spans, missing paths, directories, symlinks, out-of-workspace paths, binary-looking files, unsupported rich/binary extensions, and oversized files all fail before any write.
- `edit_file` has a conservative 1MB edit mutation cap. This is intentionally tighter than `read_file`'s 20MB hard read cap because `edit_file` performs direct filesystem mutation and holds the full normalized before/after text while validating atomic writes. Oversized-file errors explicitly state that ranged `read_file` inspection can succeed even when `edit_file` mutation is unavailable.
- Compact views omit fields that are expensive and not usually needed for the next agent action: repeated absolute paths, byte offsets, stable skeleton ids, repeated `containsParseErrors: false`, and duplicated per-line text arrays. Request `view: "full"` when those fields are needed.
- `get_file_skeleton` compact output intentionally differs from Dirac's formatted anchored text. Entry `id` values and line/byte locations are available only in full mode and are not edit anchors. Use `read_file` with `view: "edit"` when edit-compatible anchors are needed. It does not compute Dirac's optional call graph comments, does not integrate `.diracignore`, and currently supports only the JS/TS language family packaged in this server.

Output size smoke:

```powershell
cd mcp-server
npm run measure:output-size
```

The script reports deterministic character-count ratios for skeleton outline/signatures/full, read read/edit/full, search matches/files/full, and list outline/full. Approximate token counts use `ceil(chars / 4)`; no tokenizer dependency is added.

## Git Hygiene

- Use focused branches, for example `setup/mcp-scaffold` or `tool/list-files`.
- Keep commits scoped to one setup step, tool, or shared dependency.
- Treat `dirac/` as read-only upstream source material. Do not edit files inside the submodule during MCP porting sessions.
- Keep generated artifacts out of commits: `node_modules/`, `dist/`, `coverage/`, logs, local env files, and runtime indexes are ignored.
- Commit `mcp-server/package-lock.json` with package changes so future sessions are reproducible.
