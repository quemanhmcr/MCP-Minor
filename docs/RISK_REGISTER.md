# Risk Register

Full risk table. TRACKER.md carries only the top 5 rows. Update this file when risks are added, resolved, or change severity. Include a session log note when a risk is closed.

| Risk | Phase | Severity | Likelihood | Mitigation | Trigger to revisit |
| --- | --- | --- | --- | --- | --- |
| v1 kernel has undetected defects exposed by agentic loop | 0 | High | Medium | MCP-boundary acceptance tests; dogfood session before advancing | Any Phase 0 finding |
| Symbol index persistence decision delayed indefinitely | 3 | High | Medium | Explicit gate; roadmap blocked until decided | Starting any symbol tool planning |
| Partial multi-file write leaves workspace in broken state | 4 | High | Low | Mutation model must include rollback or reject-on-error before first tool ships | Phase 4 design begins |
| `execute_command` exposes command injection | 5 | Critical | Medium | Allowlist required; no shell expansion; policy document before any code | Phase 5 gate evaluation |
| Tree-sitter asset resolution breaks on rebuilt `dist` | 0–1 | Medium | Low | Built-output smoke in verification suite after any parser/runtime/build change | Any change to parser assets or build config |
| Anchor lifecycle fails under long-lived server sessions | 0–1 | Medium | Low | Session-scoped anchors; stale-hash rejection; lifecycle limits documented | Long-lived server usage emerges |
| `.diracignore` gap causes silent over-exposure | 0–2 | Low | Low | Workspace-root containment not bypassed by ignores; built-in skips cover generated/hidden | Consumer reports ignore-rule need |
| Ripgrep absent in target deployment environment | 0–5 | Medium | Low | Explicit error when `rg` not found; document system dependency in README | Deployment environment without system `rg` |
| Symbol index becomes stale between read and rename write | 4 | High | Medium | Freshness check at write time; reject if index version changed since read | Phase 4 design |
| `diagnostics_scan` depends on VS Code host diagnostics | 5 | High | Medium | Do not port until standalone strategy decided; do not stub VS Code diagnostics | Phase 5 gate evaluation |
| AST recall gap: functions absent from skeleton queries invisible to get_function | 0–2 | Medium | Low | Tests cover all emitted constructs; docs state address conventions; trigger is new construct need | Broader JS/TS recall required |
| Multi-file rename collision: target name exists in scope | 4 | Medium | Low | Collision detection required in mutation model design | Phase 4 rename design |

## Closed Risks

Record risks here when resolved with the date and resolution method. Closed risks are not removed so the history is preserved.

_(none yet)_
