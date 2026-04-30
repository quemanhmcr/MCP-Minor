# Dirac MCP Port

Standalone MCP stdio server for selected Dirac codebase tools.

This repo uses upstream Dirac only as read-only source material in `dirac/`. The runnable MCP server lives in `mcp-server/`. It does not include Dirac's VS Code UI, CLI runtime, provider/auth flow, browser workflow, skills, or subagent runtime.

This file is the canonical tool contract. Current status, risks, benchmarks, and next tasks live in [PROJECT_PORTING_TRACKER.md](PROJECT_PORTING_TRACKER.md). Upstream Dirac research lives in [DIRAC_TOOL_PORTING_NOTES.md](DIRAC_TOOL_PORTING_NOTES.md).

## Requirements

- Node.js >= 20.11.
- npm with committed `mcp-server/package-lock.json`.
- `rg` on `PATH` for `search_files`.
- MCP stdio transport only.

## Setup

```powershell
git clone --recurse-submodules <repo-url>
cd dirac-mcp
cd mcp-server
npm install
npm run build
npm run test
npm run lint
npm run typecheck
```

If the repo was cloned without submodules:

```powershell
git submodule update --init --recursive
```

## Run

```powershell
cd mcp-server
npm run dev
```

Path resolution uses:

- `DIRAC_MCP_CWD`: base directory for relative tool paths. Defaults to `process.cwd()`.
- `DIRAC_MCP_WORKSPACE_ROOTS`: `path.delimiter`-separated workspace roots. Defaults to cwd.
- `DIRAC_MCP_SESSION_ID`: optional session id for deterministic anchor state.

Example:

```powershell
$env:DIRAC_MCP_CWD = "C:\work\repo"
$env:DIRAC_MCP_WORKSPACE_ROOTS = "C:\work\repo"
npm run dev
```

## Output Views

Tools use task-oriented `view` values for token control. Compact views are the default where they matter. Full rich JSON remains available with `view: "full"`.

Legacy `format` aliases remain for compatibility:

- `format: "compact"` maps to the tool's default compact view.
- `format: "json"` maps to `view: "full"`.

Compact views omit expensive fields such as repeated absolute paths, byte offsets, stable skeleton ids, repeated false flags, and duplicated per-line arrays. Request `view: "full"` when an integration needs those fields.

## Tools

### list_files

Read-only listing for files/directories.

Input:

```ts
{
  paths: string[];
  recursive?: boolean;
  limit?: number;
  view?: "outline" | "full";
}
```

Views:

- `outline` default: newline text with `f`/`d` markers and workspace-relative paths.
- `full`: structured entries with absolute `path`, `type`, and `relativePath`.

Notes: generated/heavy directories are skipped: `node_modules`, `dist`, `coverage`, `.git`. Submodule-style `.git` files are skipped. Symlinks are not followed. Non-git hidden files remain visible.

### search_files

Read-only Rust-regex search using system `rg`.

Input:

```ts
{
  paths: string[];
  regex: string;
  filePattern?: string;
  contextLines?: number;
  limit?: number;
  view?: "matches" | "files" | "full";
  includeColumn?: boolean;
}
```

Views:

- `matches` default: grep-like `relative/path.ts:line: match`. Columns are omitted unless `includeColumn` is true.
- `files`: grouped file summary for high match counts.
- `full`: structured matches with absolute paths, byte columns, match text, and optional preview.

Notes: dotfiles, hidden directories, generated directories, and `.git` are skipped, including when targeted explicitly. Multiple regex submatches on the same line produce the first parsed match.

### read_file

Read-only UTF-8 text/code reader.

Input:

```ts
{
  paths: string[];
  startLine?: number;
  endLine?: number;
  start_line?: number;
  end_line?: number;
  lineLimit?: number;
  view?: "read" | "edit" | "full";
  includeAnchors?: boolean;
}
```

Views:

- `read` default: compact base-36 line-numbered text without edit anchors.
- `edit`: anchor-prefixed text and edit-ready anchor state for `edit_file`.
- `full`: rich per-file/per-line JSON with file hash, edit compatibility, anchors, line numbers, formatted content, and truncation metadata.

Precondition for edits: call `read_file` with `view: "edit"` for the target file in the same MCP session before `edit_file`.

Notes: full-file reads over 50KB are rejected unless a line range is supplied. The hard read cap is 20MB. Directories, missing paths, out-of-workspace paths, symlinks, binary-looking files, invalid UTF-8, and rich/binary types such as PDF, DOCX, XLSX, notebooks, and images are rejected.

### edit_file

Single-file anchored text/code replacement.

Input:

```ts
{
  path: string;
  edits: Array<{
    anchor: string;
    oldText: string;
    newText: string;
  }>;
  view?: "summary" | "full";
}
```

Views:

- `summary` default: compact edit result with file, edit count, before/after hashes, and tight line-count summaries.
- `full`: structured result with applied edits and deterministic patch summary.

Preconditions:

- The file must have been read with `read_file view: "edit"` in the same session.
- `anchor` identifies the start line.
- `oldText` must exactly match the current file span after newline normalization.
- Multiple edits must not overlap.

Wrong-view or missing-anchor failures return structured metadata with `code: "MUST_REREAD_FOR_EDIT"`, `relativePath`, `requiredView: "edit"`, and `suggestedAction`.

Notes: `edit_file` rejects stale full-file hash drift before writing, including same-line-count external changes. Validation failures produce no write. Existing dominant line ending and final newline presence are preserved. The mutation cap is 1MB.

### get_file_skeleton

Read-only AST-backed outline for JavaScript and TypeScript-family files.

Input:

```ts
{
  paths: string[];
  limit?: number;
  view?: "outline" | "signatures" | "full";
  includeImports?: boolean;
  maxSignatureChars?: number;
}
```

Views:

- `signatures` default: compact grouped imports/exports, short kind tags, line ranges, bounded signatures, and parse-error markers only where relevant.
- `outline`: cheapest navigation view, omitting signatures.
- `full`: structured skeleton with absolute paths, stable ids, line/byte locations, nested entries, parse metadata, and truncation metadata.

Supported extensions: `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`.

Entries include imports, export-only statements, exported definitions, anonymous default exports, functions, classes, constructors, methods, named arrow/function expressions, TypeScript interfaces/types/enums, duplicate names in different scopes, and practical nested members.

Notes: skeleton ids and locations are not edit anchors. Use `read_file view: "edit"` for edit-compatible anchors. For very small source files, `read_file` can be cheaper and more direct than skeleton output.

### get_function

Read-only AST-backed extraction for targeted JavaScript and TypeScript-family functions or methods.

Input:

```ts
{
  paths: string[];
  function_names: string[];
  contextLines?: number;
  sourceLineLimit?: number;
  maxSourceChars?: number;
  requireUnique?: boolean;
  includeSourceInStructured?: boolean;
  view?: "source" | "edit" | "full";
}
```

Views:

- `source` default: compact text with `relative/path::qualifiedName`, kind, line range, bounded signature, suffix-match request marker when relevant, parse-error marker only when relevant, truncation marker, and bounded line-numbered source. Structured content is summary-only.
- `edit`: same compact target output, but source lines are returned through `read_file view: "edit"` semantics and prepare `edit_file` anchors for the returned range. The header includes `body` and `view` hashes.
- `full`: structured metadata with absolute `path`, requested and resolved names, match type, kind, signature, line/byte locations, parse flags, `bodyHash`, `viewHash`, missing and ambiguous target metadata, and truncation metadata. Source text is omitted from `structuredContent` unless `includeSourceInStructured: true`.

Supported extensions: `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`.

Name matching prefers exact qualified names, then falls back to suffix-qualified names. Examples: `buildName`, `Greeter.getName`, and `getName`. Ambiguous suffix matches return all candidates plus fully qualified names by default; set `requireUnique: true` for strict ambiguity errors. Missing names are returned in metadata even when no functions match.

Notes: default output intentionally omits edit anchors and defaults `contextLines` to `0`. `paths.length * function_names.length` is capped at 200. `maxSourceChars` defaults to 30,000, has a 64 character minimum, and is capped at 120,000. Use `view: "edit"` when the next step is mutation. The tool uses the current tree-sitter skeleton scope, so it supports functions, named arrow/function expressions, constructors, and methods already visible to `get_file_skeleton`; it does not use a symbol index and does not find references, call sites, object-literal methods that are not emitted by the skeleton, or non-JS/TS symbols. TypeScript overload signatures are collapsed to the implementation when an implementation is present.

## Anchors

Anchors are deterministic, session-scoped ids used by `read_file view: "edit"` and `edit_file`.

- Format: `A` plus 6 base-36 characters.
- Encoded slots: `36^6 = 2,176,782,336`.
- Collision handling retries with salt while checking current and historical anchors for the file/session.
- Anchor state is in memory only and does not survive server restart, process replacement, explicit test reset, or session id change.

## Tree-Sitter Support

| Language family | Extensions | Status |
| --- | --- | --- |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | supported |
| TypeScript | `.ts`, `.tsx` | supported |
| Other languages | n/a | not-started |

`npm run build` copies `web-tree-sitter` runtime WASM, JS/TS/TSX grammar WASM, and MCP-owned JS/TS query assets into `dist/tree-sitter/assets/` so built output can parse without source-tree assets.

## Project Layout

- `dirac/`: pinned upstream Dirac submodule; do not edit during porting.
- `mcp-server/`: standalone TypeScript MCP server.
- `mcp-server/dist/`: generated build output; gitignored and removed after verification.
- `PROJECT_PORTING_TRACKER.md`: current state, decisions, risks, benchmarks, session protocol.
- `DIRAC_TOOL_PORTING_NOTES.md`: upstream source map and porting research.

## Git Hygiene

- Keep commits scoped to one setup step, tool, shared dependency, or docs cleanup.
- Commit `mcp-server/package-lock.json` with dependency changes.
- Do not commit generated artifacts such as `dist/`, `coverage/`, logs, local env files, or runtime indexes.
