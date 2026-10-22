# dev

Development tools for a yena checkout, as a plugin (requires core 0.3.0+).

## Usage

- `dev` or `dev help` prints the usage.
- `dev test [suite]` runs every test suite (`host` first, then each `modules/*` that has a `test` script), or just the named one. Progress shows in the console side panel as a braille bar per suite (one dot per test, eight per cell). `Esc` or `Ctrl+C` in the panel cancels the run, and so does the command context's `signal` (an assistant run that times out or is aborted cancels the test run; a signal already aborted cancels it at once). When it ends, a summary (counts, bars, failures) is printed into the transcript. Test failures do not make the command fail; the summary reports them. Without a UI that can mount views the summary is printed at the end.
- One run at a time (`A test run is already in progress`).

## How it works

1. Each suite's `package.json` `test` script is parsed (`src/script.ts`), never run through a shell. Only `node [flags] --test [--test-* flags] <globs>` is accepted; shell metacharacters, unquoted globs and `--test-reporter*` are rejected (`Unsupported test script in <suite>`).
2. Discovery (`src/child/discover.ts`): up to 4 suites in parallel, each in a child that replaces `node:test` with a counting stub (`src/child/test-shim.ts`) and imports every test file without running a test body. This gives the planned total before the first real test runs. Files are counted as `max(1, registered tests)`, a file failing to import as 1. The child runs with a private `TMPDIR` that dev deletes afterwards. If discovery fails the bar grows as results arrive (`(unplanned)`).
3. Real run: suites run one after another with the script's own flags plus `src/child/reporter.ts`, which prints one NDJSON record per test. Anything else on stdout is ignored.

## Layout

`src/`: `index.ts` (plugin), `commands.ts`, `suites.ts`, `script.ts`, `spawn.ts` (the only place that spawns), `runner.ts`, `store.ts` (outside React so the panel toggle keeps state), `layout.ts`, `summary.ts`, `format.ts`, `child/`, `ui/` (lazy: `TestView.tsx`, `mount.ts`). `kit.ts` and `ui/kit.ts` are the only files that import core (enforced by `tests/kit-boundary.test.ts`); `index.ts` never reaches react, ink or the kit UI statically.

Tests: `npm test` in this directory (they also run inside `dev test`, so the tests that spawn `node --test` rely on `spawnNode` removing `NODE_TEST_CONTEXT`). Fixtures in `tests/fixtures/` are named `*.fixture.ts` so the module's own glob does not pick them up.

## Residual risks

- Test scripts and test files of the other modules run with full rights, as they would from a shell. `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` and `NODE_TEST_CONTEXT` are removed from the child environment; other variables are inherited.
- Discovery imports test files, so top-level code of a test file runs (temp files go to the private `TMPDIR`; other side effects are not contained). Tests registered asynchronously or as subtests are not counted in the plan; the bar grows when more results arrive than planned.
- Children run in their own process group; cancel sends SIGTERM to the group and SIGKILL after 3 s, and an exit hook sends SIGKILL to live groups. No signal handlers are installed, so SIGTERM/SIGKILL on yena itself can leave a test run alive until it ends.
- Flaky tests of other modules show up as failures.
