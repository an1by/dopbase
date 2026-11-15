# End-to-end tests

These suites drive the release binary the way people use Dopbase: the CLI, the
HTTP API and the Admin UI in Chromium. They exist to catch regressions, so
every CLI command, API route and UI page gets a test.

| Suite    | Folder      | Runs                                 |
| -------- | ----------- | ------------------------------------ |
| CLI      | `cli/`      | Playwright, no browser               |
| API      | `api/`      | Playwright, no browser               |
| UI       | `ui/`       | Playwright, Desktop Chrome           |
| Journeys | `journeys/` | Playwright, browser plus CLI and API |

## Running

```bash
bun run test:e2e                     # all suites, coverage check, report
bun run test:e2e --agent             # short summary instead of the full list
bun run test:e2e:api                 # one suite
bun run test:e2e --grep @secrets     # one area, by tag
bun run test:e2e:report              # open the last HTML report
bun run test                         # format, lint, typecheck, unit tests, then e2e
bun run test:e2e:help                # every test script, flag and tag
bun run clean:test                   # delete test output and leftover servers
```

`test:e2e` rebuilds `app/target/release/dopbase` first when `app/src`,
`app/migrations` or `ui/src` changed. Set `DOPBASE_BIN` to test another build,
or pass `--skip-build`.

Journeys keep a video of every run, passed or failed, and the report plays it
next to the steps. The other suites keep video, a trace and screenshots only
when a test fails.

Everything a run writes goes to `.e2e/` at the repo root, which git ignores:
`report/index.html`, `results/` (traces, screenshots, videos), `playwright/`
(Playwright's own report), `last-run.json` and `coverage.json`.

## Testing by hand

```bash
bun run test:e2e:sandbox
```

This starts the release binary the way a spec file does, with root claimed,
two sample projects (`storefront` and `billing-api`, with development,
staging and protected production environments and their secrets) and two
people: Maya, a Member who can write to `storefront/development` and read
the rest of it, and Sam, an Admin. It prints the Admin UI address, a sign-in
link that works once for 60 seconds, the passwords, and the `export` lines
that point a CLI at the server with a personal token. Ctrl+C stops it and
deletes its files. `--empty` skips the sample data, `--keep` keeps the files,
and `--port` picks the port.

When a test fails and you want to see the state it left, run with `--keep`
(or `E2E_KEEP=1`):

```bash
bun run test:e2e:api --grep @secrets --keep
```

A file with a failed test then stops its server without deleting it. The
failure in the report, and the `--agent` summary, show a
`bun run test:e2e:sandbox --from <dir>` line that starts that server again
and signs you in as root. Kept servers live in the temp folder until
`bun run clean:test` removes them.

To watch a test instead, pass Playwright's own flags after `--`:
`-- --headed` opens a real window and `-- --debug` steps through the test in
the Playwright inspector. Each scenario in the report lists its steps with a
screen after each one, so you can also follow it by hand.

## Writing a spec

```ts
import { about, expect, step, test, useServer } from "../harness/index.ts";

const app = useServer(); // a fresh server for this file

test(
  "secret rollback saves the old value as a new version",
  {
    tag: "@secrets",
    annotation: about(
      "Rolling back keeps history: the old value comes back as version 3.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    await step("dopbase secret set (twice)", async () => {
      await app
        .cli(["secret", "set", env.ref, "API_KEY", "--stdin"], {
          stdin: app.value(),
        })
        .ok();
    });
    // …
  },
);
```

- `useServer()` boots a server on a free port with its own temp data dir and
  HOME, claims root, and stops it after the file. Options: `env`,
  `claimRoot: false`, `docs`, `dataDir` (a fixture to copy),
  `sso: true` (starts the fake OIDC provider as `app.oidc`).
- `app.cli(args)` runs the CLI signed in as root through `login --browser`.
  Pass `{ as: user }` for another account or `{ as: "anonymous" }`.
  `app.cliRaw(args, { env })` runs it with nothing but the env you give.
- `app.api` is a browser session as root. `app.apiAs(user)`,
  `app.anonymousApi()` and `app.apiWithToken(token)` give other sessions.
- `app.make` creates test data through the API: `project()`, `environment()`,
  `secret()`, `user({ role })`, `value()`. People, roles, groups and grants
  need RBAC, which is off by default: use `useServer({ env: { DOPBASE_RBAC:
"true" } })` in files that create users.
- `app.signIn(page, user)` signs a browser page in with a launch link.
- For a second browser in the same test, such as a teammate's, take the
  `newContext` fixture instead of `browser.newContext()`:
  `const context = await newContext("teammate", { baseURL: app.url })`. It
  records video under the suite's `video` setting, and the report labels the
  recording with the name you gave it.
- Helpers every suite can use live in `harness/`: `helpers.ts` has
  `tempDir`, `printVar`, `tokenEnv` and `grant`; `terminal.ts` has `pty` for
  commands that need a terminal; `server.ts` has `startBrowserLogin` and
  `startServerIn`, for a server you stop and start again on the same files.
  A suite's own `support.ts` holds only what that suite needs. Look there
  before you write a new helper.

Every test needs a description (`about(…)`) and at least one `step(…)`. The
report shows them as a scenario, and the coverage check lists a test without
them. With `strict` on in `coverage/manifest.ts`, a full run then fails. In a
test that uses `page`, `step()` attaches a screenshot after each step;
`stepOn(otherPage, …)` takes it from another page, such as a second person's
browser.

## Coverage

The helpers record what each test hits: CLI commands from `app.cli`, routes
from `app.api`, pages the browser reaches. A hit counts only in its own suite,
so journeys don't stand in for the direct tests. Factory calls and sign-in
don't count.

`coverage/check.ts` lists every command (from `dopbase help`), route (from
`/api/v1/openapi.json`) and page (from `ui/src/router.ts`) and compares. When
something truly can't be tested end to end, add it to that suite's file in
`coverage/skips/` with the reason.

## Secrets in output

Values from `app.value()` and `app.make.secret()` are remembered. A file fails
if one of them shows up in the server log, and a CLI call fails if one shows
up in `secret list`, `secret history`, `audit list` or `audit export` output.
