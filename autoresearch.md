# Autoresearch: stronger unit and Electron E2E coverage

## Objective
Increase meaningful automated regression coverage for this pi-gui repo while keeping the desktop app clean, maintainable, and verified on the real Electron surface. Prefer tests that protect user-visible Codex-style workflows, transcript/session correctness, persistence, and pure data transformations that are expensive to debug through E2E alone.

## Metrics
- **Primary**: `quality_points` (unitless, higher is better) — executable regression cases discovered by the real test runners. This is a proxy for coverage growth; do not game it with trivial tests.
- **Secondary**:
  - `core_e2e_tests`: Playwright tests listed under `apps/desktop/tests/core`
  - `live_e2e_tests`: Playwright tests listed under `apps/desktop/tests/live`
  - `native_e2e_tests`: Playwright tests listed under `apps/desktop/tests/native`
  - `unit_test_cases`: Node unit test cases discovered under package `tests/*.test.mjs`

## How to Run
Windows-first runner: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./autoresearch.ps1` outputs `METRIC name=value` lines. The `.sh` files are thin compatibility wrappers for the autoresearch harness. `./autoresearch.checks.sh` delegates to `autoresearch.checks.ps1` for correctness backpressure: package typecheck, package unit tests when present, and the desktop core Electron lane.

## Files in Scope
- `apps/desktop/src/**` — renderer pure helpers/components only when needed to make behavior testable without adding broad IPC.
- `apps/desktop/electron/**` — main/store code only when tests reveal a bug or a small seam is required.
- `apps/desktop/tests/core/**` — default E2E target for background-friendly real Electron UI coverage.
- `apps/desktop/tests/live/**` — use only for real runtime/provider behavior.
- `apps/desktop/tests/native/**` — use only for macOS OS-surface workflows; prefer targeted specs.
- `apps/desktop/tests/helpers/**` — extend shared helpers instead of duplicating harness code.
- `packages/**/src/**` and `packages/**/tests/**` — pure unit-testable package logic and Node test files.
- package scripts/tsconfig files only for adding clean test commands.

## Off Limits
- Do not delete or rewrite user session history, cached transcripts, screenshots, or temp artifacts.
- Do not add benchmark/test-count hacks, skipped fake tests, or assertions that only satisfy this metric.
- Do not broaden renderer Node/preload exposure for tests.
- Do not move production specs into faster lanes just to increase counts.
- Do not create/switch branches unless explicitly requested; current repo instructions take precedence over generic autoresearch branch setup.

## Constraints
- Every kept change must pass `./autoresearch.checks.sh`.
- Use repo lane scripts from `apps/desktop/package.json`; for desktop UI, verify with Playwright on Electron, not only unit tests.
- Keep tests deterministic, isolated, and user-behavior oriented. Use IPC only where existing helpers already use it for setup/state inspection.
- Prefer no new dependencies; use built-in `node:test` for unit tests unless a compelling reason emerges.
- Keep code clean and elegant; refactor only when it reduces test brittleness or exposes a real pure seam.

## What's Been Tried
- Session setup created this file plus PowerShell-first `autoresearch.ps1` and checks. Two early baseline attempts crashed because the harness tried to spawn `bash` on Windows; wrappers now delegate to PowerShell so the actual workload is Windows-native. Baseline pending.
