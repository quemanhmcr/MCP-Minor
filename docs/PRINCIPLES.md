# Tracker Principles

These govern all decisions in this project. They do not change without a Decision Log entry in [DECISIONS.md](DECISIONS.md) explaining why.

---

1. **Full tool support is the long-term target.** Nothing is abandoned. Deferred means gated, not deleted. Every blocked tool has an explicit architecture gate and a phase on the roadmap.

2. **Do not implement advanced tools before their architecture gates exist.** A gate is not bureaucracy. It is the minimum design work required to avoid building on an unstable foundation. Gate conditions are documented in [ARCHITECTURE_GATES.md](ARCHITECTURE_GATES.md).

3. **v1 is a kernel, not the final product.** The six tools are credible but not complete. Completeness is the North Star defined in the tracker. Adding tools is legitimate; skipping gates is not.

4. **Features require acceptance tests.** A tool is not production-ready until it passes tests at the MCP JSON-RPC boundary, not just handler unit tests. Production-ready criteria are unchanged: README contract, unit tests, MCP smoke, built smoke, benchmark row, no open TODOs.

5. **Persistence is an architecture decision.** Symbol index storage, anchor lifecycle, and session state are explicit choices with trade-offs. They are recorded in the Decision Log before implementation begins, not after.

6. **Command execution is a security product.** No sandbox policy, no port. The policy document comes before the code. A working implementation is not evidence that the policy is correct.

7. **Multi-file mutation requires diff, report, and rollback design.** Write-side correctness is harder than read-side. Design the failure model before implementing the happy path. A partial-write scenario that corrupts the workspace is a data loss event.

8. **Dogfooding determines ergonomics priorities.** Do not add `.diracignore`, insert-anchor editing, or rich file extraction because they sound useful. Add them because Phase 0 evidence shows they are needed. Opinions without evidence go to Active Risks as candidates, not to the sprint.

9. **Deferred does not mean abandoned.** Every blocked tool is on the roadmap with an explicit gate. When the gate is satisfied, the tool comes next. The roadmap is updated when gates change, not when enthusiasm changes.

---

## Working Discipline

### Scope and Sources

- Read order in a new session: TL;DR, README contracts, upstream notes only when porting or auditing Dirac behavior.
- One session, one goal. Do not port more than one tool or one small shared dependency unless explicitly re-planned.
- Adjacent issues go to Active Risks or Next Sessions unless they block the stated goal.
- Work in `mcp-server/`; `dirac/` is read-only. Do not add HTTP/SSE or command execution without a Decision entry.

### Evidence

- Claims need evidence: tests for behavior, MCP smoke for MCP tools, built smoke for runtime/assets, benchmarks for size/perf.
- New behavior needs at least one test that would have failed before the change.
- Do not call a tool `production-ready` until the production-ready checklist passes.

### Contracts

- Schemas, views, defaults, aliases, anchor format, and error codes are README contracts.
- Prefer additive changes. Renames/removals need a deprecation alias or migration note plus a Decision entry.
- Default compact output is a contract; changing it requires README, Tool Status, Decision, and output-size verification.

### Safety

- Resolve input paths inside configured workspace roots; reject symlink escapes.
- Mutations validate fully before writing; preserve no-partial-write behavior for validation failures.
- Stale anchors, unknown anchors, and oldText mismatches fail clearly; do not auto-heal.
- Never commit generated artifacts (`dist/`, `build/`, `.turbo/`, `node_modules/`, coverage, logs).

### Git

- Start with `git status --short --branch`; preserve unrelated dirty worktree changes.
- Touch only files needed for the goal.
- Commits are one logical unit and name the affected tool/area. Submodule pin changes need a Decision entry.

### Production-Ready Checklist

- README contract updated.
- Tool Status row updated.
- Unit/domain tests cover happy paths and edges.
- MCP smoke passes; built smoke passes; real pinned Dirac smoke passes for Dirac behavior.
- Compact and full outputs verified; scalable outputs have a benchmark row.
- Workspace/path safety tested.
- No unresolved `TODO`, `FIXME`, `xit`, or `.skip` in touched handler/test code.

### Anti-Patterns

- Do not paraphrase tool contracts outside README.
- Do not put upstream source maps or Dirac architecture in TRACKER.
- Do not keep benchmark history in Markdown; git history has old measurements.
- Do not mark a tool production-ready until MCP-callable, tested, documented, and verified.
- Do not mark behavior done because it works on one fixture.
- Do not claim Dirac parity without reading the upstream source.
- Do not hide host-specific Dirac behavior behind MCP stubs.
- Do not leave `mcp-server/dist/` after builds.
- Do not edit `dirac/` files.
- Do not bypass workspace path checks for convenience.
- Do not silence a failing real-repo smoke; investigate or revert.
- Do not expand scope because adjacent tool code is nearby.
- Do not implement a gated tool before its gate condition is satisfied and recorded in DECISIONS.md.
- Do not treat a phase as complete without its exit gate criteria met.
