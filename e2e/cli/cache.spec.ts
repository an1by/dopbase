import { printVar, tempDir } from "../harness/helpers.ts";
import { about, expect, step, test, useServer } from "../harness/index.ts";
import { browserLogin, freshClientEnv } from "./support.ts";

const app = useServer();

/**
 * A client dir of its own, signed in as root, whose cache holds `count`
 * environments, one per `dopbase run`. The cache is per login, so each
 * test gets its own.
 */
async function cachedClient(count: number) {
  const env = await freshClientEnv(app, "cache");
  expect((await browserLogin(app, env)).code).toBe(0);
  const refs: string[] = [];
  for (let i = 0; i < count; i++) {
    const environment = await app.make.environment();
    await app.make.secret(environment, "API_KEY");
    await app
      .cliRaw(["run", environment.ref, "--", ...printVar("API_KEY")], { env })
      .ok();
    refs.push(environment.ref);
  }
  return { env, refs };
}

test(
  "cache list shows cached environments",
  {
    tag: "@cache",
    annotation: about(
      "After `dopbase run`, `cache list` shows the environment it cached for this server, as JSON and as a table, without values.",
    ),
  },
  async () => {
    const empty = {
      HOME: app.server.root,
      DOPBASE_URL: app.url,
      DOPBASE_DATA_DIR: await tempDir(app, "empty"),
    };
    const none = await step("dopbase cache list before any run", async () =>
      app.cliRaw(["cache", "list"], { env: empty }).stdout(),
    );
    await step("It says there are no cache entries", async () => {
      expect(none).toBe(
        `No encrypted runtime cache entries found for ${app.url}.`,
      );
    });

    const { env, refs } = await step(
      "dopbase login, then dopbase run in one environment",
      async () => cachedClient(1),
    );
    const listed = await step("dopbase --json cache list", async () =>
      app.cliRaw(["--json", "cache", "list"], { env }).json(),
    );
    await step("It shows one entry for the environment", async () => {
      expect(listed.server_url).toBe(app.url);
      expect(listed.entry_count).toBe(1);
      const [entry] = listed.entries;
      expect(`${entry.project}/${entry.environment}`).toBe(refs[0]);
      expect(entry.environment_id).toMatch(/^env_/);
      expect(entry).not.toHaveProperty("entries");
    });
    const table = await step("dopbase cache list", async () =>
      app.cliRaw(["cache", "list"], { env }).stdout(),
    );
    await step(
      "The table names the server and counts 1 cached environment",
      async () => {
        expect(table).toMatch(
          /^SERVER\s+PROJECT\s+ENVIRONMENT\s+ID\s+FETCHED\s+AGE\s+ALIASES/,
        );
        expect(table).toContain(app.url);
        expect(table).toMatch(/1 cached environment$/);
      },
    );
  },
);

test(
  "cache clean removes entries by age and with --all",
  {
    tag: "@cache",
    annotation: about(
      "`cache clean --older-than` keeps fresh entries and removes old ones, `--dry-run` changes nothing, `--all --yes` empties the cache, and without --yes it needs a terminal.",
    ),
  },
  async () => {
    const { env } = await step(
      "dopbase login, then dopbase run in 2 environments",
      async () => cachedClient(2),
    );
    const kept = await step(
      "dopbase --json cache clean --older-than 30d --yes",
      async () =>
        app
          .cliRaw(
            ["--json", "cache", "clean", "--older-than", "30d", "--yes"],
            { env },
          )
          .json(),
    );
    await step("Fresh entries are kept", async () => {
      expect(kept.matched_count).toBe(0);
      expect(kept.removed_count).toBe(0);
      expect(kept.remaining_count).toBe(2);
    });
    await step(
      "dopbase cache clean --older-than 1s --dry-run matches both once they age",
      async () => {
        await expect
          .poll(
            async () =>
              (
                await app
                  .cliRaw(
                    [
                      "--json",
                      "cache",
                      "clean",
                      "--older-than",
                      "1s",
                      "--dry-run",
                    ],
                    { env },
                  )
                  .json()
              ).matched_count,
          )
          .toBe(2);
        const list = await app
          .cliRaw(["--json", "cache", "list"], { env })
          .json();
        expect(list.entry_count).toBe(2);
      },
    );
    const unconfirmed = await step(
      "dopbase cache clean --older-than 1s without --yes",
      async () =>
        app.cliRaw(["cache", "clean", "--older-than", "1s"], { env }).fails(1),
    );
    await step("It asks for --yes", async () => {
      expect(unconfirmed.stderr).toContain("Pass --yes");
    });
    const byAge = await step(
      "dopbase cache clean --older-than 1s --yes",
      async () =>
        app
          .cliRaw(["cache", "clean", "--older-than", "1s", "--yes"], { env })
          .stdout(),
    );
    await step("It removes both and says how many remain", async () => {
      expect(byAge).toContain(
        "Removed 2 encrypted runtime cache entries. 0 entries remain.",
      );
    });

    const second = await cachedClient(1);
    const all = await step("dopbase --json cache clean --all --yes", async () =>
      app
        .cliRaw(["--json", "cache", "clean", "--all", "--yes"], {
          env: second.env,
        })
        .json(),
    );
    await step("--all removes the fresh entry too", async () => {
      expect(all.all).toBe(true);
      expect(all.removed_count).toBe(1);
      expect(all.remaining_count).toBe(0);
    });
    const after = await step(
      "dopbase cache clean --all --yes again",
      async () =>
        app
          .cliRaw(["cache", "clean", "--all", "--yes"], { env: second.env })
          .stdout(),
    );
    await step("There is nothing left to remove", async () => {
      expect(after).toBe("No encrypted runtime cache entries were removed.");
    });
  },
);
