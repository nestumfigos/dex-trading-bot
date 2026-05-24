# Phase 1: Dead Code + Structure (Behavior-Preserving)

**Date**: 2026-05-24
**Owner**: nestumfigos
**Campaign**: Ruflo Autonomous Improvement, Phase 1 of N

---

## Context

User requested a full Ruflo autonomous improvement swarm across the dex-trading-bot project covering live, paper, and perp bots, self_learning / self_evolution modules, agent logic, SQL, APIs, and dashboard. Scope is too broad for a single design — decomposed into 6 sequential phases. This document covers **Phase 1 only**.

The dirty working tree (67 uncommitted files, ~1700+/6000- lines) is being parked on `wip/pre-ruflo-cleanup` before any swarm work begins.

## Phase 1 Goal

Behavior-preserving cleanup of three repos:
1. Remove dead code (never-imported files, never-called exports, unreachable branches, commented-out blocks).
2. Improve structure (split files >500 LOC, rename ambiguous identifiers, move misplaced modules to match `docs/ARCHITECTURE.md`).
3. **No** logic changes, **no** strategy intent changes, **no** API contract changes.

Out of scope for Phase 1 (deferred to later phases): test generation, correctness fixes, perf uplift, SQL audit, self-learning audit.

## Repo Layout

| Repo | Path | Branch | Notes |
|------|------|--------|-------|
| Live (spot) | `C:\Users\User_\Desktop\dex-trading-bot` | `main` | This repo. Active live bot. |
| Paper | `C:\Users\User_\Desktop\dex-trading-bot-paper` | `paper-main` (worktree of live repo) | Same git history as live, different branch. |
| Perps | `C:\Users\User_\Desktop\dex-trading-bot-perps` | `main` (separate repo) | Only initial scaffold commit. In D.13 paper soak. |

## Branch Strategy

```
live repo:
  main           <- current HEAD 5e11b0a, becomes baseline
  wip/pre-ruflo-cleanup  <- parks the 67 uncommitted files
  ruflo/phase1-live      <- swarm works here, PR → main

paper worktree (same repo):
  paper-main             <- current HEAD 480f431, becomes baseline
  ruflo/phase1-paper     <- swarm works here, PR → paper-main

perps repo (separate):
  main                   <- current HEAD eb60871, becomes baseline
  ruflo/phase1-perps     <- swarm works here, PR → main
```

Three independent PRs, each reviewable in isolation.

## Dead-Code Definition (Eligible for Removal)

**IN scope:**
1. **Never-imported files**: source file with zero `require`/`import` references across all 3 repos.
2. **Never-called exports**: exported function/class/const with no call site anywhere.
3. **Unreachable branches**: code after unconditional `return` / `throw`, dead `if (false)` blocks, post-`continue` code in loops.
4. **Commented-out code blocks**: stale `// old code` / `/* commented logic */` blocks. (Not docstring comments. Not TODO/FIXME notes referencing real work.)

**OUT of scope (kept):**
- Reachable but feature-flag-disabled code (e.g., `TRADERXO_PERPS_LIVE_ADAPTER_ENABLED=false` paths — code is wired but config disables it).
- Code referenced only by tests (still load-bearing for safety net).
- Code referenced only in docs/runbooks (proves the documented behavior).

## Structure Changes (Eligible)

1. **File splits**: any file >500 LOC (per CLAUDE.md rule) gets proposed split into focused modules. Behavior preserved by re-export shim from old path. Split lines along natural boundary (exported symbol clusters), not arbitrary cuts.
2. **Renames**: functions/vars whose name actively misleads (`processData` → specific verb-noun). Mechanical find+replace across all 3 repos. No semantic changes.
3. **Module moves**: file lives in `utils/` but is risk logic → moves to `risk/` per ARCHITECTURE.md module map. Imports updated globally.

**Out of scope for Phase 1:**
- API signature changes
- New abstractions / extractions / interfaces
- Reorganizing the ARCHITECTURE.md module map itself
- Public dashboard endpoint URL changes

## Approval & Commit Discipline

**Mode**: auto-apply, user reviews final PR.

**Commit granularity** — one commit per category per repo, in this order:
1. `phase1: remove commented-out code blocks`
2. `phase1: remove unreachable branches`
3. `phase1: remove never-called exports`
4. `phase1: remove never-imported files`
5. `phase1: rename ambiguous identifiers`
6. `phase1: move misplaced modules`
7. `phase1: split files >500 LOC`

This ordering lets the user cherry-pick (e.g., accept deletions, reject splits) at PR review without manual git surgery.

## Test Gate (Strict)

**Per-commit gate**: `npm test` (resolves to `node --test "test/**/*.test.js"`) must exit 0 before the swarm proceeds to the next category. This includes any tests touching live SQL / RPC / network.

**Consequences user has accepted:**
- Each commit waits on live SQL connection + RPC calls (slow).
- Transient network failures can stall the swarm — operator (you) re-triggers or skips.
- Swarm cannot land a commit on a red test, even if the failure is unrelated to the change.

**If a test starts failing during cleanup**, the swarm:
1. Captures the failure output.
2. Reverts the offending commit.
3. Files the failure as a follow-up issue (text report, not auto-fixed in Phase 1).
4. Continues with remaining categories.

## Perps-Specific Warning

Every commit to the perps repo invalidates the D.13 paper soak baseline. The swarm will:
- Tag each perps PR commit message with `[SOAK-RESET]`.
- Emit a final summary noting how many soak-resetting commits landed.
- Operator (you) re-starts perps paper soak observation after merge.

## Swarm Topology

Per CLAUDE.md SendMessage-first coordination pattern:

```
researcher (named: researcher)
  ↓ SendMessage findings
architect (named: architect)
  ↓ SendMessage design
coder (named: coder)
  ↓ SendMessage diff batch
tester (named: tester)
  ↓ SendMessage pass/fail
reviewer (named: reviewer)
  ↓ produces final PR description
```

All 5 agents spawned in **one message**, all `run_in_background: true`, each prompt names who to message next. After spawn the lead (Claude main) stops and waits for completion notifications — no polling.

Per-repo: same 5-agent pipeline runs 3x (live, paper, perps) on independent branches. The three pipelines execute in parallel during the swarm phase (different branches/worktrees, no working-tree collision). Merge-time conflicts can still occur between live and paper because they share git history — handled per "Error Handling → Merge conflicts" below.

## Data Flow per Repo

```
1. researcher  → enumerates all src/**/*.js files, builds import graph,
                 grep -r for each exported symbol, identifies dead candidates,
                 measures file LOC + identifier name quality.
                 OUTPUT: candidates.json with categories.

2. architect   → reviews candidates, drops false positives
                 (dynamic require, eval, reflection), groups by commit category,
                 produces ordered change plan.
                 OUTPUT: plan.md with 7 commit-sized changesets.

3. coder       → applies one changeset at a time on branch ruflo/phase1-<repo>,
                 commits per category, never amends.
                 OUTPUT: 7 commits (or fewer if a category has no candidates).

4. tester      → runs npm test after each coder commit, signals pass/fail.
                 On fail: signals coder to revert + file follow-up.
                 OUTPUT: test results per commit.

5. reviewer    → reads full branch diff vs main HEAD, drafts PR title + body
                 + summary stats (LOC removed, files deleted, files renamed,
                 files moved, files split), flags any pattern concerns.
                 OUTPUT: PR description ready for user review.
```

## Error Handling

**Swarm-level failures** (a named agent dies, hangs, or returns garbage):
- Lead detects via missing SendMessage within reasonable window.
- Lead notifies operator with last known state.
- Operator decides: restart that agent, skip, or abort phase.

**Test failures during cleanup**: handled per "Test Gate" above (revert, file follow-up, continue).

**Merge conflicts** (between the 3 parallel branches, e.g., live + paper share files):
- Live and paper share a git history. Paper changes happen on `paper-main`, live on `main`. If both branches modify the same line of a shared file, the second-to-merge PR sees the conflict.
- Mitigation: live PR merges first, paper rebases on top, perps is independent.

## Testing the Spec (Behavior Preservation)

The Phase 1 success criterion is **behavior equivalence**, defined operationally as:
- `npm test` passes at every commit and at PR HEAD.
- Live bot starts, scans, and processes one full cycle on a smoke run without new errors.
- Paper bot equivalent smoke run passes.
- Perps bot equivalent smoke run passes.

Smoke runs are operator-triggered post-merge, not part of the swarm itself.

## Non-Goals (Explicit Exclusions)

- No correctness fixes, even if the swarm spots them. (Files as follow-up backlog instead.)
- No test additions. (Phase 3 if user picks tests-next.)
- No PnL improvements, no strategy changes, no parameter tuning. (Phase 6.)
- No SQL query changes, no migration edits. (Phase 2.)
- No new dependencies, no `package.json` changes (other than removing unused deps if a future cleanup phase covers that).
- No docs changes other than this spec.

## Open Questions Resolved During Brainstorm

| # | Question | Answer |
|---|----------|--------|
| 1 | Handle 67 uncommitted files? | Branch + commit WIP on `wip/pre-ruflo-cleanup`, swarm on new branch |
| 2 | Which phase first? | Phase 1: dead code + structure |
| 3 | Which repos? | All 3 in parallel |
| 4 | Perps in P1? | Yes (with SOAK-RESET tagging) |
| 5 | What counts as dead? | Never-imported + never-called + unreachable + commented-out. NOT flag-gated reachable code. |
| 6 | Structure changes? | Splits + renames + moves. No new abstractions. |
| 7 | Approval cadence? | Auto-apply, user reviews final PR. Commits granular by category. |
| 8 | Test gate? | All tests including live deps must pass on every commit. Strictest. |

## Definition of Done for Phase 1

- 3 PRs open (or merged): live, paper, perps.
- All commits in each PR have green `npm test`.
- Reviewer agent has produced summary stats per PR.
- Operator (you) has reviewed and merged each PR.
- Smoke runs pass on each merged repo.
- Follow-up backlog file exists at `docs/superpowers/backlog/2026-05-24-phase1-followups.md` listing any deferred correctness fixes the swarm spotted but did not apply.
- Phase 1 task #5 unblocks: "Merge Phase 1, brainstorm Phase 2."
