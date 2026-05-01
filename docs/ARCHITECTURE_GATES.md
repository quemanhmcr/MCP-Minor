# Architecture Gates

Each gate is a prerequisite for a blocked capability. No implementation work begins until the gate is satisfied and a Decision Log entry is recorded in [DECISIONS.md](DECISIONS.md).

Gates are not bureaucracy. They are the minimum design work required to avoid building on an unstable foundation. A gate satisfies itself when evidence exists, not when the implementation seems straightforward.

---

## .diracignore

**What is blocked:** Project-specific ignore file support in `list_files` and `search_files`.

**Why it is blocked:** Workspace-root containment plus built-in generated/hidden skips are sufficient for the current v1 tools. Adding ignore file parsing before consumer demand is speculative scope.

**Evidence that unlocks it:** A real consumer reports that built-in skips are insufficient for their project structure and that they need project-specific ignore rules. Dogfood or acceptance testing that surfaces ignore-rule pain counts.

**Decision record required:** Record the consumer use case, the chosen ignore format (`.diracignore`, `.gitignore`-style, or other), and whether ignore rules operate independently or inherit gitignore semantics.

---

## Symbol Index Persistence

**What is blocked:** Any symbol-aware tool: `find_symbol_references`, `replace_symbol`, `rename_symbol`.

**Why it is blocked:** Symbol lookup requires a queryable index of symbol definitions and references across the workspace. The index must be built from source files, and its persistence model determines correctness guarantees. Upstream Dirac uses SQLite WASM; a standalone MCP server needs an independent persistence decision.

**Options to decide between:**
- Persistent workspace index (SQLite WASM or equivalent): survives restarts; requires invalidation.
- Session-scoped index: built on first symbol query; discarded on server restart; no persistence complexity.
- Demand-built index: built per-request; no persistence; high latency for large workspaces.

**Evidence that unlocks it:** Explicit decision on persistence model, index build trigger (on-demand vs background), invalidation strategy (file watch vs on-access vs manual), and index scope (single root vs multi-root).

**Decision record required:** Persistence model chosen, build trigger, invalidation approach, and scope. Record trade-offs rejected.

---

## find_symbol_references

**What is blocked:** The `find_symbol_references` tool.

**Why it is blocked:** Requires a symbol index that maps symbol names to definition and reference locations. Without the index, reference lookup is either impossible or requires full-workspace grep that cannot distinguish same-named symbols.

**Evidence that unlocks it:** Symbol index persistence decision made (gate above) and the index is built, queried, and validated on fixture workspaces.

**Decision record required:** Persistence decision (from Symbol Index gate). No separate decision required if that gate is already recorded.

---

## replace_symbol

**What is blocked:** The `replace_symbol` tool.

**Why it is blocked:** Requires two things the codebase does not yet have: (1) unambiguous AST range resolution for a named symbol across one or more files, and (2) a mutation model that defines how writes are applied, what happens on partial failure, and whether rollback exists. Implementing this without the mutation model produces tools that corrupt workspaces on failure.

**Evidence that unlocks it:** Symbol index gate satisfied. Mutation model designed and documented covering: single-file vs multi-file write strategy, partial-failure behavior (reject-on-first-error, rollback, or staged preview), and diff/report format.

**Decision record required:** Mutation model choice: atomic transaction, per-file sequential with rollback, or staged preview. Diff format (unified diff, structured JSON, or per-symbol summary).

---

## rename_symbol

**What is blocked:** The `rename_symbol` tool.

**Why it is blocked:** Rename is a superset of replace: it requires symbol index lookup for all references, disambiguation across scopes and files, multi-file writes, and a reporting model that communicates what changed across the workspace. It inherits all gates from symbol index and replace_symbol.

**Evidence that unlocks it:** Symbol index gate and replace_symbol gate both satisfied. Multi-file diff and reporting format defined. Rename collision detection designed (e.g., target name already exists in scope).

**Decision record required:** Same decisions as replace_symbol, plus rename collision handling policy.

---

## diagnostics_scan

**What is blocked:** The `diagnostics_scan` tool.

**Why it is blocked:** Upstream Dirac's diagnostics are VS Code host diagnostics — they rely on the language server protocol running inside the VS Code extension host. A standalone MCP server cannot access VS Code diagnostics. Any port that stubs these produces a tool that reports nothing or reports incorrect diagnostics.

**Options to decide between:**
- TypeScript language server via `typescript` npm package: standalone but heavyweight.
- ESLint only: lightweight; covers lint errors but not type errors.
- Full LSP client integration: accurate; significant implementation complexity.
- Defer indefinitely: document the limitation.

**Evidence that unlocks it:** Standalone diagnostics strategy chosen that does not depend on VS Code host. Strategy must be validated on a real TypeScript project to confirm it surfaces real errors.

**Decision record required:** Strategy chosen, toolchain dependency documented, and known limitations stated.

---

## execute_command

**What is blocked:** The `execute_command` tool.

**Why it is blocked:** Command execution is a security product, not a convenience feature. Without a sandbox model and permission policy, any implementation exposes the host environment to arbitrary code execution from MCP callers. The policy must be reviewed before any code is written.

**Decisions required before implementation:**
- Sandbox strategy: OS-level isolation, subprocess isolation, command allowlist, or none.
- Permission model: caller-declared, consumer config file, per-invocation approval, or deny-by-default with explicit allow.
- Process limits: timeout, output size cap, memory cap.
- Environment restrictions: inherited env, stripped env, or explicit allowlist.

**Evidence that unlocks it:** Policy document exists, is reviewed (not just written), and covers all four decisions above. Acceptance tests must cover allowlist enforcement and process limit behavior before the tool ships.

**Decision record required:** All four policy decisions. The policy document path must be referenced in the Decision Log.

---

## Rich File Extraction

**What is blocked:** Non-text formats in `read_file`: PDF, DOCX, XLSX, Jupyter notebooks, images.

**Why it is blocked:** Rich extraction requires binary parsing dependencies (pdf-parse, mammoth, xlsx, etc.) that introduce significant package weight, licensing considerations, and security surface. Partial implementation (some formats but not others) with unclear error messages is worse than no implementation.

**Evidence that unlocks it:** Consumer explicitly needs a specific format. Packaging and licensing reviewed for the required dependencies. Unsupported-format error behavior defined for all other binary types.

**Decision record required:** Which formats are in scope, which dependencies are approved, and what the error message contract is for unsupported formats.

---

## Multi-File Editing

**What is blocked:** Any batched or cross-file variant of `edit_file`.

**Why it is blocked:** Multi-file edits require a transaction model. A write that succeeds on file A and fails on file B leaves the workspace in an inconsistent state. Without a rollback or reject-on-error design, multi-file editing is a latent corruption risk.

**Evidence that unlocks it:** Mutation model designed (same gate as replace_symbol), diff/report format defined, and rollback or reject-on-error behavior acceptance-tested. The failure model must be tested explicitly — do not treat the happy path as sufficient.

**Decision record required:** Transaction strategy, diff format, and rollback approach. Must be tested before any multi-file edit tool ships.
