# Porting Tracker

This file is the live operational state for coding-agent sessions. It contains current status, decisions, risks, benchmarks, verification commands, and session handoff notes. It does not define tool contracts; those live in [README.md](README.md). It does not map upstream Dirac source internals; those live in [DIRAC_TOOL_PORTING_NOTES.md](DIRAC_TOOL_PORTING_NOTES.md).

## TL;DR

- Branch: `main`; upstream `dirac/` submodule pinned at `e827ec30d4cdae078588df2040f203b780d657ad`.
- Production-ready tools: `list_files`, `search_files`, `read_file`, `edit_file`, `get_file_skeleton`, `get_function`.
- Current output contract: compact task-oriented `view` defaults; `view: "full"` for rich JSON; legacy `format` aliases remain.
- Next recommended implementation task: audit `.diracignore` needs or plan symbol index persistence.
- Generated artifacts must stay out of git; remove `mcp-server/dist/` after builds.

## Working Discipline

This is the operating standard for coding-agent sessions. If a rule conflicts with a plan, change the plan.

### Scope And Sources

- Read order: TL;DR, README contracts, then upstream notes only when porting or auditing Dirac behavior.
- One session, one goal. Do not port more than one tool or one small shared dependency unless explicitly re-planned.
- Adjacent issues go to Active Risks or Next Sessions unless they block the stated goal.
- Work in `mcp-server/`; `dirac/` is read-only. Do not add HTTP/SSE or command execution without a Decision entry.
- Canonical sources: README for contracts, this tracker for live state, DIRAC_TOOL_PORTING_NOTES for upstream research.

### Evidence

- Claims need evidence: tests for behavior, MCP smoke for MCP tools, real pinned Dirac smoke for Dirac parity, built smoke for runtime/assets, benchmarks for size/perf.
- New behavior needs at least one test that would have failed before the change.
- Do not call a tool `production-ready` until the checklist below passes. One fixture or one path is not enough.

### Contracts

- Schemas, views, defaults, aliases, anchor format, and error codes are README contracts.
- Prefer additive changes. Renames/removals need a deprecation alias or migration note plus a Decision entry.
- Default compact output is a contract; changing it requires README, Tool Status, Decision, and output-size verification.
- `view: "full"` is the rich-output opt-in. Legacy `format: "json"` is only an alias.

### Safety

- Resolve input paths inside configured workspace roots and reject symlink escapes.
- Mutations validate fully before writing and preserve no-partial-write behavior for validation failures.
- Stale anchors/hashes, unknown anchors, and oldText mismatches fail clearly; do not auto-heal them.
- Never commit generated artifacts (`dist/`, `build/`, `.turbo/`, `node_modules/`, coverage, logs).

### Testing

- New MCP tools need handler/domain tests, schema validation, MCP in-memory smoke, and real pinned Dirac smoke when porting Dirac behavior.
- File/path tools cover: invalid input, oversized input, missing path, directory path, unsupported type, non-UTF-8/binary-looking file, symlink escape, out-of-workspace path, and permission denied when stable locally.
- Runtime/asset tools need built `dist` smoke. Compact and full outputs each need shape assertions.

### Output And Tokens

- Defaults are compact and agent-readable; full structured payloads require documented opt-in views.
- Measure size at the MCP boundary: `content` plus `structuredContent`.
- Scalable outputs need a Benchmarks Current row before `production-ready`.
- Compact navigation/summarization output larger than raw source is a product bug unless justified.

### Documentation

- Update README for contracts, this tracker for state/risks/decisions/benchmarks/sessions, and DIRAC_TOOL_PORTING_NOTES for upstream research.
- Session Log entries stay short: date, area, outcome, verification, next.
- Decisions are append-only and state the choice, reason, and revisit condition. Replace benchmark snapshots instead of keeping history.

### Git And Worktree

- Start with `git status --short --branch`; preserve unrelated dirty worktree changes.
- Touch only files needed for the goal. Do not revert, reformat, stash, commit, or push unrelated/user changes unless explicitly asked.
- Commits are one logical unit and name the affected tool/area. Submodule pin changes need a Decision entry.

### Production-Ready Checklist

A tool may be marked `production-ready` only when all apply:

- README contract, Tool Status, and Session Log are updated.
- Unit/domain tests cover happy paths and relevant edges.
- MCP smoke passes; real pinned Dirac smoke passes for Dirac behavior; built smoke passes for runtime/assets.
- Compact and full outputs are verified; scalable outputs have a benchmark row.
- Workspace/path safety is tested.
- No unresolved `TODO`, `FIXME`, `xit`, or `.skip` remains in touched handler/test code.

## Tool Status

| Tool | Status | Languages | Gaps | Risk |
| --- | --- | --- | --- | --- |
| `list_files` | production-ready | n/a | no `.diracignore`, no line counts/mtimes | low |
| `search_files` | production-ready | n/a | no `.diracignore`, system `rg` required, no bundled rg | low |
| `read_file` | production-ready | UTF-8 text/code | no rich extraction for PDF/DOCX/XLSX/notebooks/images | medium |
| `edit_file` | production-ready | UTF-8 text/code | single-file replace-only, no insert/end-anchor/multi-file batching | medium |
| `get_file_skeleton` | production-ready | JS/TS/JSX/TSX | no call graph comments, no non-JS/TS languages | medium |
| `get_function` | production-ready | JS/TS/JSX/TSX | skeleton-query recall limits, no symbol index/references/non-JS/TS languages | medium |
| `find_symbol_references` | not-started | undecided | needs symbol index and persistence decision | high |
| `replace_symbol` | not-started | undecided | needs AST range resolution and mutation model | high |
| `rename_symbol` | not-started | undecided | needs symbol index and multi-file diff/reporting | high |
| `diagnostics_scan` | not-started | undecided | upstream is host/integration-heavy | high |
| `execute_command` | not-started | n/a | needs sandbox/permission policy | high |

See README for tool schemas and output views.

## Active Risks

- `.diracignore` gap: standalone ignore behavior is not full Dirac parity. Mitigation: workspace-root containment plus built-in generated/hidden skips. Trigger to revisit: user needs project-specific ignore rules.
- Rich file extraction gap: `read_file` supports text/code only. Mitigation: explicit unsupported-file errors. Trigger to revisit: consumer needs PDF/DOCX/XLSX/notebook/image extraction.
- Edit scope gap: `edit_file` is single-file replace-only. Mitigation: strict anchored validation and no-partial-write behavior. Trigger to revisit: consumer needs multi-file or insert-specific edits.
- Anchor lifecycle: anchors are in-memory and session-scoped. Mitigation: `edit_file` requires prior `read_file view: "edit"` and rejects stale hashes. Trigger to revisit: long-lived server sessions need cleanup or persistence.
- Tree-sitter language scope: only JS/TS/TSX assets and queries are packaged. Mitigation: fail unsupported extensions clearly. Trigger to revisit: porting non-JS/TS AST tools.
- AST recall coupling: `get_function` consumes `get_file_skeleton` candidates, so constructs absent from skeleton queries are absent from targeted extraction. Mitigation: tests cover emitted functions, arrows, object shorthand methods, constructors, getters/setters, generators, default exports, private methods, computed methods, and decorated methods; docs state address conventions and limitations. Trigger to revisit: broader JS/TS symbol recall or non-JS/TS symbols become requirements.
- Symbol index: persistence model is undecided. Mitigation: defer symbol tools. Trigger to revisit: starting `find_symbol_references` or `rename_symbol`.
- Command execution: no permission model exists. Mitigation: keep unported. Trigger to revisit: explicit sandbox policy is designed.

## Verification Commands

Run from `c:\project\lamviec\dirac-mcp\mcp-server` after runtime/source/test changes:

```powershell
npm run build
npm run test
npm run lint
npm run typecheck
```

Run output-size smoke when changing output contracts or token behavior:

```powershell
npm run measure:output-size
```

Run tree-sitter built-output smoke when changing parser assets/runtime or AST tools:

```powershell
npm run build
node dist/tree-sitter/smoke.js ..\dirac\src\services\tree-sitter\languageParser.ts ..\dirac\scripts\file-utils.mjs
```

Run from repo root before finishing any session:

```powershell
git status --short --branch
git submodule status
Test-Path mcp-server/dist
git diff --stat
```

If `mcp-server/dist/` exists after verification:

```powershell
Remove-Item -Recurse -Force mcp-server/dist
```

Docs-only sessions do not need the full npm suite unless they make or verify behavior claims. They still need repo status, submodule, dist, and diff checks.

## Benchmarks Current

Measured on 2026-04-30 with `npm run measure:output-size`. True MCP-visible size is `content` chars plus `JSON.stringify(structuredContent).length`. Approximate tokens use `ceil(chars / 4)`.

| Scenario | Raw chars | Compact total chars | Full total chars | Ratio |
| --- | ---: | ---: | ---: | --- |
| `read_file view:"read"` on `mcp-server/src/filesystem/file-skeleton.ts` | 28,955 | 31,646 | 379,452 | 1.093x raw / 0.083x full |
| `read_file view:"edit"` on same file | 28,955 | 36,943 | 379,452 | 1.276x raw / 0.097x full |
| `get_file_skeleton view:"outline"` on same file | 28,955 | 2,872 | 72,100 | 0.099x raw / 0.040x full |
| `get_file_skeleton view:"signatures"` on same file | 28,955 | 9,121 | 72,100 | 0.315x raw / 0.127x full |
| `get_function view:"source"` for `getWorkspaceFileSkeleton` in same file | 28,955 | 1,213 | 2,502 | 0.042x raw / 0.485x full |
| `get_function view:"edit"` for same target | 28,955 | 1,404 | 2,502 | 0.048x raw / 0.561x full |
| React/TSX generic fixture signatures | 2,511 | 1,752 | 11,294 | 0.698x raw / 0.155x full |
| `search_files view:"matches"` over `mcp-server/src/**/*.ts` | n/a | 10,960 | 85,138 | 0.129x full |
| `search_files view:"files"` over same query | n/a | 1,423 | 85,138 | 0.017x full |
| `list_files view:"outline"` on `mcp-server/src` | n/a | 1,176 | 9,810 | 0.120x full |

Edit workflow tax on `mcp-server/src/filesystem/file-skeleton.ts`:

| Exploratory reads before edit | Old always-edit-ready chars | New read-then-reread-edit chars | Result |
| ---: | ---: | ---: | --- |
| 1 | 36,943 | 68,589 | old-style cheaper by 31,646 |
| 3 | 110,829 | 131,881 | old-style cheaper by 21,052 |
| 5 | 184,715 | 195,173 | old-style cheaper by 10,458 |

For this file, the new workflow becomes cheaper at about seven exploratory reads before one edit. Use `read_file view: "edit"` immediately when editing is likely.

## Next Sessions

1. Audit `.diracignore` needs: decide whether standalone tools need project ignore files or built-in skips remain enough.
2. Plan symbol index persistence: required before references/rename tools.
3. Consider `edit_file` insert/end-anchor extensions only if consumers need edits outside returned line anchors.
4. Design command execution policy: required before any `execute_command` exposure.

## Anti-Patterns

- Do not paraphrase tool contracts outside README.
- Do not put upstream source maps or Dirac architecture in this tracker.
- Do not keep benchmark history in Markdown; git history has old measurements.
- Do not mark a tool production-ready until it is MCP-callable, tested, documented, and verified.
- Do not mark behavior done because it works on one fixture.
- Do not claim parity with Dirac without reading the upstream source.
- Do not hide host-specific Dirac behavior behind MCP stubs.
- Do not leave `mcp-server/dist/` after builds.
- Do not edit upstream `dirac/` files.
- Do not bypass workspace path checks for convenience.
- Do not silence a failing real-repo smoke; investigate or revert.
- Do not expand scope during a tool port because adjacent tool code is nearby.
- Do not add generated artifacts, runtime indexes, logs, or coverage to git.

## Decisions Log

- 2026-04-29: Build a standalone MCP server instead of trying to boot Dirac's `ToolExecutor`. Reason: upstream handlers depend on VS Code/UI/telemetry/task services that do not fit headless MCP.
- 2026-04-29: Keep transport stdio-first. Reason: no real HTTP/SSE consumer exists.
- 2026-04-29: Treat `dirac/` as a pinned read-only submodule. Reason: preserves upstream reference integrity.
- 2026-04-29: Use TypeScript NodeNext ESM and explicit `.js` imports. Reason: matches runtime package expectations and avoids ambiguous module resolution.
- 2026-04-29: Keep runtime context slim: cwd, session id, workspace roots. Reason: isolates MCP tools from Dirac host state.
- 2026-04-29: Use workspace-root containment and realpath/symlink rejection for file reads/edits. Reason: direct filesystem tools need explicit safety boundaries.
- 2026-04-29: Use deterministic session-scoped anchors instead of Dirac random dictionary words. Reason: reproducible MCP tests and stable sessions.
- 2026-04-29: Make `edit_file` conservative: require exact oldText, non-overlap, same-session anchors, full-file hash freshness, and no partial writes. Reason: direct filesystem mutation has no host approval UI.
- 2026-04-29: Keep `edit_file` single-file replace-only initially. Reason: reduces blast radius while preserving core anchored edit behavior.
- 2026-04-29: Defer `.diracignore`. Reason: workspace containment plus built-in skips are enough for current tools.
- 2026-04-29: Use system `rg` for `search_files`. Reason: avoids bundling/licensing decisions until necessary.
- 2026-04-29: Pin `web-tree-sitter@0.22.6` with `tree-sitter-wasms@^0.1.13`. Reason: newer `web-tree-sitter` failed to load the selected grammar binaries.
- 2026-04-29: Copy tree-sitter runtime, grammar WASM, and query assets into `dist`. Reason: built output must not depend on source-tree assets.
- 2026-04-29: Start AST tooling with `get_file_skeleton`. Reason: validates parser/query/output integration before narrower function lookup.
- 2026-04-30: Make compact task-oriented views the default and keep full JSON explicit. Reason: tool output should reduce model context, not exceed raw file reads.
- 2026-04-30: Replace `format` as the primary API with `view`, while keeping `format` aliases. Reason: `view` separates task intent from serialization/detail level.
- 2026-04-30: Require `read_file view: "edit"` before `edit_file`. Reason: default reads should be cheap, while edit anchors are paid only when mutation is intended.
- 2026-04-30: Use `A` plus 6 base-36 anchor ids with retry/checking. Reason: reduces edit-view token cost while keeping session/file uniqueness invariants.
- 2026-04-30: Measure true MCP-visible payload as content plus structuredContent JSON. Reason: many clients expose both channels to models.
- 2026-04-30: Keep documentation split by role: README contract, tracker state, notes upstream research. Reason: prevents drift and reduces session resume cost.
- 2026-04-30: Make `get_function` default to compact bounded source without anchors, with `view: "edit"` as the explicit edit-ready mode. Reason: targeted reads should stay cheap unless mutation is intended.
- 2026-04-30: Keep `get_function` no-match and ambiguous suffix matches as structured results instead of tool errors. Reason: agents recover better from predictable result shapes with candidate metadata; operational failures remain errors.
- 2026-04-30: Use canonical `function_names` in the MCP schema while accepting `functionNames` only as a handler compatibility alias. Reason: avoids two visible fields with overlapping semantics.
- 2026-04-30: Split `get_function` hashes into `bodyHash` and `viewHash`, and omit source from `view: "full"` structured metadata unless explicitly requested. Reason: body identity should not drift with context, and MCP clients often expose both text and structured channels.
- 2026-04-30: Cap `get_function` by path count, name count, and returned result items instead of raw `paths * names`. Reason: the limit should bound parse/output cost without rejecting broad but still small-result requests.

## Session Log

### Recent Sessions

- 2026-04-30 - `get_function` expert hardening - changed no-match/ambiguous suffixes to structured results, defaulted context to 0, added path revalidation, request caps, overload collapse, body/view hashes, metadata-only full output, and CRLF/BOM/unicode/truncation coverage. Verification: `npm run build`, `npm run test` (185 tests), `npm run lint`, `npm run typecheck`, built tree-sitter smoke, `npm run measure:output-size`. Next: audit `.diracignore` needs or plan symbol index persistence.
- 2026-04-30 - `get_function` coverage closure - added skeleton-kind reachability contracts, decorator-inclusive function ranges, compact structured match metadata, Unicode NFC matching, edit-view parity coverage, overload edge tests, request/result cap refinement, and matching/threat-model docs. Verification: `npm run build`, `npm run test` (189 tests), `npm run lint`, `npm run typecheck`, built tree-sitter smoke, `npm run measure:output-size`. Next: audit `.diracignore` needs or plan symbol index persistence.
- 2026-04-30 - `get_function` - ported targeted JS/TS function extraction with compact/full/edit views, ambiguity and missing-target handling. Verification: `npm run build`, `npm run test`, `npm run lint`, `npm run typecheck`, built tree-sitter smoke, `npm run measure:output-size`, repo status/submodule/dist/diff checks. Next: audit `.diracignore` needs or plan symbol index persistence.
- 2026-04-30 - docs architecture cleanup - rewrote README/TRACKER/NOTES by canonical role: contract, live state, upstream research. Next: review diffs, then port `get_function`.
- 2026-04-30 - output view calibration - measured true MCP-visible payloads, tightened `read_file` views to 1.093x/1.276x raw, documented anchor entropy, added wrong-view edit metadata and React/TSX signature coverage. Next: `get_function`.
- 2026-04-30 - token-efficient views - added `view` modes for all current tools, compact defaults, full JSON modes, `format` aliases, and output-size measurement. Next: calibrate defaults.
- 2026-04-29 - `get_file_skeleton` - ported AST-backed JS/TS skeleton tool, added safe loading, compact/full views, hard fixtures, MCP smoke, built smoke, and pinned Dirac repo smoke. Next: compact outputs.
- 2026-04-29 - tree-sitter runtime - added `web-tree-sitter`/WASM asset strategy, copy script, parser API, tests, and built-output smoke. Next: skeleton tool.

### Older Sessions

- 2026-04-29 - setup - cloned Dirac, chose standalone MCP architecture, scaffolded `mcp-server/`, pinned submodule, normalized git hygiene.
- 2026-04-29 - `list_files` - ported and hardened workspace-safe deterministic listing.
- 2026-04-29 - tool responses - added shared tool registration and structured success/error helpers.
- 2026-04-29 - `search_files` - ported ripgrep-backed search with generated/hidden skips and bounded output.
- 2026-04-29 - parity audit - smoked list/search against `dirac/` and fixed submodule-style `.git` leak.
- 2026-04-29 - docs handoff - reorganized tracker and notes for early session continuity.
- 2026-04-29 - `read_file` - ported text reads, ranges, hashes, anchors, workspace safety, output caps, and rich-file deferrals.
- 2026-04-29 - anchor reconciliation - replaced hash-bucket preservation with ordered LCS-style reconciliation and duplicate/reorder tests.
- 2026-04-29 - `edit_file` - ported single-file anchored replacement, exact validation, stale/overlap protection, line-ending preservation, and anchor refresh.
- 2026-04-29 - edit freshness - added stored full-file hash snapshots and stale hash rejection.
- 2026-04-29 - edit cap metadata - exposed read-time edit compatibility and oversized edit guidance.

## Session Completion Checklist

Use this at the end of each session:

```text
Session:
Area/tool:
Status: production-ready | partial | not-started
Files changed:
Contract changes:
Tests/verification:
Benchmarks/smoke:
Docs updated:
Dist removed:
Remaining risks:
Next recommended task:
```
