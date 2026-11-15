import { printVar, tempDir } from "../harness/helpers.ts";
import {
  about,
  expect,
  step,
  test,
  useServer,
  type Environment,
} from "../harness/index.ts";
import { Proxy } from "./support.ts";

const app = useServer();

/** A runner token for `env`, made with `dopbase token create`. */
async function runnerToken(env: Environment): Promise<string> {
  const created = await app
    .cli(["--json", "token", "create", env.ref, "--name", app.uniq("ci")])
    .json();
  return created.plaintextToken;
}

/** Env for a CI machine: only the runner token and its own client dir. */
async function runnerEnv(
  token: string,
  url = app.url,
): Promise<Record<string, string>> {
  return {
    HOME: app.server.root,
    DOPBASE_URL: url,
    DOPBASE_TOKEN: token,
    DOPBASE_DATA_DIR: await tempDir(app, "runner"),
  };
}

test(
  "the child process sees the secrets as env vars",
  {
    tag: "@run",
    annotation: about(
      "`dopbase run <ref> -- <cmd>` starts the command with every secret as an env var, reports how many keys it loaded, and never passes DOPBASE_TOKEN on.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const apiKey = await app.make.secret(env, "API_KEY");
    const dbUrl = await app.make.secret(env, "DATABASE_URL");
    const result = await step(
      `dopbase run ${env.ref} -- sh -c 'printf "%s|%s" "$API_KEY" "$DATABASE_URL"'`,
      async () =>
        app
          .cli([
            "run",
            env.ref,
            "--",
            "sh",
            "-c",
            'printf "%s|%s" "$API_KEY" "$DATABASE_URL"',
          ])
          .ok(),
    );
    await step("The child prints both values", async () => {
      expect(result.stdout).toBe(`${apiKey}|${dbUrl}`);
    });
    await step(
      "stderr names the environment, 2 keys and source=live",
      async () => {
        expect(result.stderr).toContain(
          `Dopbase: ${env.ref} (${env.id}), 2 key(s), source=live`,
        );
      },
    );
    const byId = await step(`dopbase run ${env.id} -- … (by id)`, async () =>
      app.cli(["run", env.id, "--", ...printVar("API_KEY")]).stdout(),
    );
    await step("An environment id works as the reference", async () => {
      expect(byId).toBe(apiKey);
    });
    const missing = await step(
      `dopbase run ${env.projectName}/nope -- true`,
      async () =>
        app.cli(["run", `${env.projectName}/nope`, "--", "true"]).fails(1),
    );
    await step(
      "An unknown environment fails before starting the child",
      async () => {
        expect(missing.stderr).toContain("ENVIRONMENT_NOT_FOUND");
      },
    );
  },
);

test(
  "the child's exit code passes through",
  {
    tag: "@run",
    annotation: about(
      "`dopbase run` exits with the child's exit code, and a command that can't start fails with a message.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    await app.make.secret(env, "API_KEY");
    await step(`dopbase run ${env.ref} -- sh -c 'exit 7' exits 7`, async () => {
      await app.cli(["run", env.ref, "--", "sh", "-c", "exit 7"]).fails(7);
    });
    await step(`dopbase run ${env.ref} -- true exits 0`, async () => {
      await app.cli(["run", env.ref, "--", "true"]).ok();
    });
    const notFound = await step(
      `dopbase run ${env.ref} -- no-such-command-here`,
      async () =>
        app.cli(["run", env.ref, "--", "no-such-command-here"]).fails(),
    );
    await step("It says the command failed to start", async () => {
      expect(notFound.stderr).toContain("failed to start no-such-command-here");
    });
  },
);

test(
  "run works with a runner token in DOPBASE_TOKEN",
  {
    tag: ["@run", "@tokens"],
    annotation: about(
      "With only a runner token, `dopbase run -- <cmd>` uses the token's environment, keeps it out of the output, and refuses a reference to another environment.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const value = await app.make.secret(env, "API_KEY");
    const token = await step(
      `dopbase token create ${env.ref} --name ci`,
      async () => runnerToken(env),
    );
    const ci = await runnerEnv(token);
    const result = await step(
      "DOPBASE_TOKEN=dbs_… dopbase run -- sh -c …",
      async () =>
        app.cliRaw(["run", "--", ...printVar("API_KEY")], { env: ci }).ok(),
    );
    await step(
      "The child gets the value; stderr doesn't name the environment",
      async () => {
        expect(result.stdout).toBe(value);
        expect(result.stderr).toContain("Dopbase: 1 key(s), source=live");
        expect(result.stderr).not.toContain(env.ref);
      },
    );
    const tokenSeen = await step(
      "The child doesn't see DOPBASE_TOKEN",
      async () =>
        app
          .cliRaw(["run", "--", ...printVar("DOPBASE_TOKEN")], { env: ci })
          .stdout(),
    );
    await step("It prints nothing", async () => {
      expect(tokenSeen).toBe("");
    });
    await step(
      `DOPBASE_TOKEN=… dopbase run ${env.ref} -- … checks the reference`,
      async () => {
        const same = await app
          .cliRaw(["run", env.ref, "--", ...printVar("API_KEY")], { env: ci })
          .stdout();
        expect(same).toBe(value);
      },
    );
    const other = await app.make.environment();
    const refused = await step(
      `DOPBASE_TOKEN=… dopbase run ${other.ref} -- true`,
      async () =>
        app.cliRaw(["run", other.ref, "--", "true"], { env: ci }).fails(1),
    );
    await step("A reference to another environment is refused", async () => {
      expect(refused.stderr).toContain(
        `The runner token cannot access ${other.ref}`,
      );
    });
  },
);

test(
  "run falls back to the encrypted cache when the server is down",
  {
    tag: "@run",
    annotation: about(
      "After one live run, `dopbase run` with the server unreachable uses the encrypted cache and warns; with no cache it refuses to start the child.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const value = await app.make.secret(env, "API_KEY");
    const token = await runnerToken(env);
    const proxy = await Proxy.start(app.server.port);
    try {
      const ci = await runnerEnv(token, proxy.url);
      const live = await step(
        "dopbase run -- … while the server is up",
        async () =>
          app.cliRaw(["run", "--", ...printVar("API_KEY")], { env: ci }).ok(),
      );
      await step("It loads live and fills the cache", async () => {
        expect(live.stdout).toBe(value);
        expect(live.stderr).toContain("source=live");
      });
      await step("The server goes away", async () => {
        await proxy.cut();
      });
      const cached = await step(
        "dopbase run -- … with the server down",
        async () =>
          app.cliRaw(["run", "--", ...printVar("API_KEY")], { env: ci }).ok(),
      );
      await step("The child still gets the value, from the cache", async () => {
        expect(cached.stdout).toBe(value);
        expect(cached.stderr).toContain("Using encrypted cache fetched at");
        expect(cached.stderr).toContain("source=cache");
      });
      const fresh = await runnerEnv(token, proxy.url);
      const nothing = await step(
        "dopbase run -- … with the server down and no cache",
        async () =>
          app
            .cliRaw(["run", "--", "sh", "-c", "echo started"], { env: fresh })
            .fails(1),
      );
      await step("It refuses and never starts the child", async () => {
        expect(nothing.stderr).toContain(
          "no usable encrypted cache is available",
        );
        expect(nothing.stdout).not.toContain("started");
      });
    } finally {
      await proxy.cut().catch(() => {});
    }
  },
);

test(
  "names that load code are left out unless --only names them",
  {
    tag: "@run",
    annotation: about(
      "Secrets named PAGER, GIT_SSH_COMMAND or PYTHONPATH could make the child run code, so `dopbase run` doesn't inject them; naming one with `--only` passes it through.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const apiKey = await app.make.secret(env, "API_KEY");
    const pager = await app.make.secret(env, "PAGER");
    const sshCommand = await app.make.secret(env, "GIT_SSH_COMMAND");
    const pythonPath = await app.make.secret(env, "PYTHONPATH");
    const show =
      'printf "%s|%s|%s|%s" "$API_KEY" "$PAGER" "$GIT_SSH_COMMAND" "$PYTHONPATH"';

    const all = await step(`dopbase run ${env.ref} -- …`, async () =>
      app.cli(["run", env.ref, "--", "sh", "-c", show]).stdout(),
    );
    await step("Only API_KEY comes from Dopbase", async () => {
      const [key, ...rest] = all.split("|");
      expect(key).toBe(apiKey);
      for (const value of [pager, sshCommand, pythonPath]) {
        expect(rest).not.toContain(value);
      }
    });
    const named = await step(
      `dopbase run ${env.ref} --only PAGER -- …`,
      async () =>
        app
          .cli(["run", env.ref, "--only", "PAGER", "--", ...printVar("PAGER")])
          .stdout(),
    );
    await step("Naming PAGER with --only passes it", async () => {
      expect(named).toBe(pager);
    });
  },
);

test(
  "key selection flags include or exclude the right keys",
  {
    tag: "@run",
    annotation: about(
      "`--only` injects just the named keys and stops on a missing one unless `--allow-missing`; `--preserve-env` keeps a variable the caller already set.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const apiKey = await app.make.secret(env, "API_KEY");
    const dbUrl = await app.make.secret(env, "DATABASE_URL");
    await app.make.secret(env, "PORT", "9000");
    const both = 'printf "%s|%s|%s" "$API_KEY" "$DATABASE_URL" "$PORT"';

    const only = await step(
      `dopbase run ${env.ref} --only API_KEY -- …`,
      async () =>
        app
          .cli(["run", env.ref, "--only", "API_KEY", "--", "sh", "-c", both])
          .ok(),
    );
    await step("Only API_KEY reaches the child", async () => {
      expect(only.stdout).toBe(`${apiKey}||`);
      expect(only.stderr).toContain("1 of 3 key(s)");
    });
    const list = await step(
      `dopbase run ${env.ref} --only API_KEY,DATABASE_URL -- …`,
      async () =>
        app
          .cli([
            "run",
            env.ref,
            "--only",
            "API_KEY,DATABASE_URL",
            "--",
            "sh",
            "-c",
            both,
          ])
          .stdout(),
    );
    await step("A comma list injects both", async () => {
      expect(list).toBe(`${apiKey}|${dbUrl}|`);
    });
    const missing = await step(
      `dopbase run ${env.ref} --only NOPE -- true`,
      async () =>
        app.cli(["run", env.ref, "--only", "NOPE", "--", "true"]).fails(1),
    );
    await step("A key that isn't stored stops the run", async () => {
      expect(missing.stderr).toContain("NOPE");
    });
    const allowed = await step(
      `dopbase run ${env.ref} --only API_KEY,NOPE --allow-missing -- …`,
      async () =>
        app
          .cli([
            "run",
            env.ref,
            "--only",
            "API_KEY,NOPE",
            "--allow-missing",
            "--",
            ...printVar("API_KEY"),
          ])
          .ok(),
    );
    await step("--allow-missing warns and runs", async () => {
      expect(allowed.stdout).toBe(apiKey);
      expect(allowed.stderr).toContain(
        "Dopbase warning: --only key(s) not stored: NOPE",
      );
    });
    const preserved = await step(
      `PORT=8080 dopbase run ${env.ref} --preserve-env PORT -- …`,
      async () =>
        app
          .cli(
            ["run", env.ref, "--preserve-env", "PORT", "--", "sh", "-c", both],
            {
              env: { PORT: "8080" },
            },
          )
          .ok(),
    );
    await step(
      "The caller's PORT wins; the other keys are injected",
      async () => {
        expect(preserved.stdout).toBe(`${apiKey}|${dbUrl}|8080`);
        expect(preserved.stderr).toContain(
          "Dopbase: kept existing value for: PORT",
        );
      },
    );
    const overridden = await step(
      `PORT=8080 dopbase run ${env.ref} -- … without --preserve-env`,
      async () =>
        app
          .cli(["run", env.ref, "--", ...printVar("PORT")], {
            env: { PORT: "8080" },
          })
          .stdout(),
    );
    await step("Without the flag the stored PORT replaces it", async () => {
      expect(overridden).toBe("9000");
    });
  },
);
