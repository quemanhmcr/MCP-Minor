# Porting Tracker

Supporting docs: [Acceptance](docs/V1_ACCEPTANCE.md) · [Gates](docs/ARCHITECTURE_GATES.md) · [Risks](docs/RISK_REGISTER.md) · [Decisions](docs/DECISIONS.md) · [Principles](docs/PRINCIPLES.md) · [Upstream Notes](DIRAC_TOOL_PORTING_NOTES.md) · [Contracts](README.md)

---

## TL;DR

- Branch: `main` · submodule pinned at `e827ec30d4cdae078588df2040f203b780d657ad`
- **Current phase: Phase 0 — dogfood v1 kernel, write MCP-boundary acceptance tests**
- Next tool to implement: **none** until Phase 0 acceptance tests pass
- Production-ready tools: `list_files`, `search_files`, `read_file`, `edit_file`, `get_file_skeleton`, `get_function`
- Never commit `mcp-server/dist/`

---

## Product Thesis

- Standalone stdio MCP server exposing Dirac-derived code tools without VS Code, UI, or task-host dependencies.
- Transport: stdio only. Runtime: TypeScript NodeNext ESM, Node ≥ 20.11. No persistent storage decision yet.
- `dirac/` is read-only pinned source material, not a framework to boot.
- Workspace-root containment + symlink rejection are non-negotiable safety boundaries.
- Full tool surface (symbol intelligence, refactoring, command execution) is the long-term target; each phase has an explicit architecture gate.

---

## v1 Kernel

| Tool | Role | Gap |
| --- | --- | --- |
| `list_files` | Enumerate workspace structure | No `.diracignore` |
| `search_files` | Locate files by content pattern | System `rg` required |
| `read_file` | Read content; acquire edit anchors | Text/code only |
| `get_file_skeleton` | Summarize file structure without full source | JS/TS/JSX/TSX only |
| `get_function` | Extract targeted function body or signature | JS/TS/JSX/TSX only |
| `edit_file` | Apply validated anchored replacements | Single-file replace-only |

---

## ⚑ Next Session — Phase 0

- [ ] Start server over stdio; verify `InitializeResult` lists all six tools.
- [ ] Call each tool against real files; confirm no protocol errors.
- [ ] Exercise the full chain: `list` → `search` → `read` → `get_function` → `edit`.
- [ ] Test stale-anchor rejection: edit after re-read, then re-edit with old anchors.
- [ ] Test workspace containment: path outside root, traversal path, symlink.
- [ ] Test non-text rejection: call `read_file` on a `.wasm` binary.
- [ ] Test unsupported language: call `get_file_skeleton` on a `.py` file.
- [ ] Verify anchor determinism: same file, same session → same anchor ids.
- [ ] Write one MCP-boundary acceptance test per tool that would fail if the tool broke.
- [ ] Log ergonomics friction (anchor UX, error messages, view selection) in session log.

Full acceptance criteria: [docs/V1_ACCEPTANCE.md](docs/V1_ACCEPTANCE.md)

---

## Roadmap

| Phase | Goal | Status | Exit gate |
| --- | --- | --- | --- |
| **0** | v1 validation + MCP acceptance tests | **current** | All six tools pass MCP-boundary tests; ergonomics findings logged |
| 1 | v1 hardening + documentation | next | No open TODOs; known limits in README; errors reviewed cold |
| 2 | Evidence-based ergonomics | gated on Phase 0 | Phase 0 findings justify each change; acceptance tests added |
| 3 | Symbol intelligence foundation | gated on persistence decision | Persistence decided; `find_symbol_references` passes acceptance tests |
| 4 | Multi-file refactoring tools | gated on Phase 3 + mutation model | `replace_symbol`, `rename_symbol` pass multi-file + failure-mode tests |
| 5 | Command execution + diagnostics | gated on security policy | Policy reviewed; sandbox enforced; no VS Code host dependency |

---

## Architecture Gates

| Capability | Gate condition | Decision required |
| --- | --- | --- |
| `.diracignore` | Consumer ignore-rule pain reported | Ignore format and inheritance model |
| Symbol index | Persistence model chosen | Model, build trigger, invalidation, scope |
| `find_symbol_references` | Symbol index gate satisfied | (inherits from symbol index) |
| `replace_symbol` | Symbol index + mutation model designed | Transaction strategy, diff format |
| `rename_symbol` | Symbol index + mutation model + collision policy | Superset of replace_symbol |
| `diagnostics_scan` | Standalone diagnostics strategy chosen | Strategy; no VS Code host dependency |
| `execute_command` | Sandbox + permission policy reviewed | Sandbox, permissions, limits, env restrictions |
| Rich file extraction | Packaging + licensing decided | In-scope formats, approved deps |
| Multi-file editing | Diff + report + rollback model designed | Transaction strategy, failure behavior |

Each gate requires a DECISIONS.md entry before implementation begins. Full reasoning: [docs/ARCHITECTURE_GATES.md](docs/ARCHITECTURE_GATES.md)

---

## Top Risks

| Risk | Phase | Severity | Mitigation |
| --- | --- | --- | --- |
| v1 defects surface under agentic loop | 0 | High | MCP-boundary acceptance tests before advancing |
| Symbol index persistence blocked indefinitely | 3 | High | Explicit gate; no symbol tool without decision |
| Partial multi-file write corrupts workspace | 4 | High | Rollback or reject-on-first-error required in design |
| `execute_command` exposes command injection | 5 | Critical | Policy document reviewed before any code written |
| Tree-sitter asset resolution breaks on `dist` | 0–1 | Medium | Built-output smoke after every parser/build change |

Full risk register: [docs/RISK_REGISTER.md](docs/RISK_REGISTER.md)

---

## Tool Status

| Tool | Status | Languages | Gate |
| --- | --- | --- | --- |
| `list_files` | production-ready | n/a | — |
| `search_files` | production-ready | n/a | — |
| `read_file` | production-ready | UTF-8 text/code | — |
| `edit_file` | production-ready | UTF-8 text/code | — |
| `get_file_skeleton` | production-ready | JS/TS/JSX/TSX | — |
| `get_function` | production-ready | JS/TS/JSX/TSX | — |
| `find_symbol_references` | not-started | undecided | Symbol index persistence |
| `replace_symbol` | not-started | undecided | AST range + mutation model |
| `rename_symbol` | not-started | undecided | Symbol index + diff/rollback |
| `diagnostics_scan` | not-started | undecided | Standalone diagnostics strategy |
| `execute_command` | not-started | n/a | Sandbox + permission policy |

---

## Session Log

- **2026-05-01** — tracker restructure — rewrote as staged maturity roadmap with product thesis, North Star, six-phase roadmap, architecture gates, risk register, and supporting docs. Next: Phase 0 dogfood.
- **2026-04-30** — `get_function` expert hardening — structured no-match/ambiguous results, request caps, overload collapse, body/view hashes, full metadata-only output. 185 tests pass. Next: Phase 0.
- **2026-04-30** — `get_function` coverage closure — reachability contracts, decorator ranges, Unicode NFC, edit-view parity, overload edges. 189 tests pass. Next: Phase 0.

---

## Session Completion Checklist

```
Session:
Area/tool:
Phase at start / end:
Phase exit gate met: yes | no | partial
Files changed:
Contract changes:
Tests/verification: npm run build && npm run test && npm run lint && npm run typecheck
Built smoke: node dist/tree-sitter/smoke.js ...
Benchmarks updated:
Docs updated:
dist/ removed: Test-Path mcp-server/dist
git status clean:
Next recommended task:
```
