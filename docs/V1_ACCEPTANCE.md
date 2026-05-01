# Phase 0 — v1 Acceptance Criteria

Run these against the MCP server over stdio after `npm run build`. Each scenario must pass before Phase 0 is closed and Phase 1 begins. Record failures as session log entries; file tracking issues in Active Risks until resolved.

---

## Startup

- Start `node dist/index.js` with stdio transport and send `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}`.
- Expected: valid `InitializeResult` with `protocolVersion`, `serverInfo`, and `capabilities.tools` listing all six v1 tools.
- Fail condition: process exits, emits non-JSON on stdout, or returns MCP error.

---

## list_files

- Call `list_files` with `path` pointing at `mcp-server/src/`.
- Expected: compact directory tree in `content`; no `node_modules`, no `dist`, no hidden files.
- Call with a path outside the workspace root.
- Expected: tool error with a clear out-of-workspace message; no file listing.
- Call with a non-existent path.
- Expected: tool error; not a crash.

---

## search_files

- Call `search_files` with a pattern that matches known files in `mcp-server/src/`.
- Expected: match results including file paths and line content.
- Call with a pattern that matches nothing.
- Expected: empty results, not an error.
- Call with `view:"files"` and verify only file paths are returned (no line content).

---

## read_file — normal view

- Call `read_file view:"read"` on `mcp-server/src/filesystem/file-skeleton.ts`.
- Expected: file content in `content`; `anchor` fields absent or null.
- Verify output size is within documented benchmarks (~31,646 chars compact).

---

## read_file — edit view

- Call `read_file view:"edit"` on the same file.
- Expected: content includes anchor markers (`A` + 6 base-36 chars); `fileHash` present in structured output.
- Verify anchors are deterministic: same call on same file produces same anchor ids in the same session.
- Verify a second call on the same unchanged file produces identical anchor ids.

---

## edit_file — anchored replace

- Create `mcp-server/src/__edit_test__.ts` with known content (e.g., two short functions). Do not use a real source file.
- Acquire anchors via `read_file view:"edit"` on that file.
- Call `edit_file` with a valid `startAnchor`, `endAnchor`, and exact `oldText` from the anchor region.
- Expected: file modified; new anchors returned; old anchors invalidated.
- Call `edit_file` again with the old (now stale) anchors.
- Expected: tool error citing stale hash or unknown anchor; file unchanged.
- Call `edit_file` with a mismatched `oldText`.
- Expected: tool error citing text mismatch; file unchanged.
- Remove `mcp-server/src/__edit_test__.ts` after the test; do not commit it.

---

## get_file_skeleton

- Call `get_file_skeleton view:"outline"` on `mcp-server/src/filesystem/file-skeleton.ts`.
- Expected: compact function/class list; no full source bodies.
- Call `get_file_skeleton view:"signatures"` on the same file.
- Expected: signatures with parameter types; still no full source bodies.
- Call on a `.py` file.
- Expected: tool error citing unsupported language; no crash.

---

## get_function

- Call `get_function` with `paths` and `function_names` targeting a known function in `mcp-server/src/`.
- Expected: compact bounded source in `content`; `bodyHash` present.
- Call with an unknown function name.
- Expected: structured no-match result with candidates if any; not a tool error.
- Call `get_function view:"edit"` and verify anchor markers are present.

---

## Workspace Containment

- Call `read_file` with an absolute path outside all configured workspace roots.
- Expected: tool error; no file content returned.
- Call `list_files` with `path: "../../"` or an equivalent traversal.
- Expected: tool error or clamped to workspace root; no parent directory listing.

---

## Symlink Rejection

- If a symlink exists inside `mcp-server/` pointing outside the workspace, call `read_file` on it.
- Expected: tool error citing symlink escape rejection; no content returned.
- If no symlink exists, create a temporary one for the test, run the test, then remove it.

---

## Non-Text Rejection

- Call `read_file` on a binary file (e.g., a `.wasm` file in `mcp-server/`).
- Expected: tool error citing binary or non-UTF-8 content; no partial content returned.

---

## Deterministic Anchors

- In one session, call `read_file view:"edit"` on the same file twice without modifying the file between calls.
- Expected: identical anchor ids both times.
- Start a new server session and repeat.
- Expected: anchor ids may differ between sessions (session-scoped), but must be consistent within a session.

---

## Error Message Quality

For each error scenario above, verify:
- Error message is a single clear sentence stating what failed and why.
- Error does not expose internal stack traces or file system paths outside the workspace.
- Error includes enough context for an agent to retry correctly (e.g., "anchor stale, re-read file with view:edit").

---

## Completion Gate

Phase 0 closes when:

- All scenarios above pass without manual workarounds.
- Failures are either fixed or recorded as known limitations in README.
- At least one automated test per tool exists at the MCP JSON-RPC boundary.
- Ergonomics findings from the session are documented in the session log.
