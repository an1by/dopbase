import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { printVar, tempDir } from "../harness/helpers.ts";
import {
  ROOT,
  ROOT_EMAIL,
  answerBrowserLogin,
  about,
  expect,
  step,
  test,
  useServer,
} from "../harness/index.ts";
import { freePort } from "../harness/server.ts";
import { pty } from "../harness/terminal.ts";
import { browserLogin, freshClientEnv, script } from "./support.ts";

const app = useServer({ env: { DOPBASE_RBAC: "true" } });

test(
  "client connect saves a server and rejects a bad one",
  {
    tag: "@auth",
    annotation: about(
      "`client connect <url>` asks before switching, saves the URL in config.toml and reports it; a second connect is a no-op, and an unreachable or malformed address is refused.",
    ),
  },
  async () => {
    // client connect refuses to run while DOPBASE_URL is set, so this client
    // has only HOME and its own data dir.
    const dir = await tempDir(app, "connect");
    const env = { HOME: dir, DOPBASE_DATA_DIR: join(dir, "client") };

    const switched = await step(
      `dopbase client connect ${app.url}, answering y to "Continue?"`,
      async () =>
        pty(["client", "connect", app.url], {
          env,
          steps: [{ wait: "Continue?", send: "y\r" }],
        }),
    );
    await step("It says Connected and warns about plain HTTP", async () => {
      expect(switched.code).toBe(0);
      expect(switched.output).toContain(`Connected to ${app.url}.`);
      expect(switched.output).toContain("Plain HTTP does not encrypt traffic");
    });

    const again = await step(
      `dopbase --json client connect ${app.url} again`,
      async () =>
        app.cliRaw(["--json", "client", "connect", app.url], { env }).json(),
    );
    await step(
      "Nothing changes: changed is false and the server is reachable",
      async () => {
        expect(again.server_url).toBe(app.url);
        expect(again.changed).toBe(false);
        expect(again.server_reachable).toBe(true);
      },
    );
    const status = await step("dopbase --json client status", async () =>
      app.cliRaw(["--json", "client", "status"], { env }).json(),
    );
    await step("Status shows the saved server from config", async () => {
      expect(status.server_url).toBe(app.url);
      expect(status.server_source).toBe("config");
      expect(status.authentication).toBe("none");
    });

    const deadPort = await freePort();
    const unreachable = await step(
      `dopbase client connect http://127.0.0.1:${deadPort}`,
      async () =>
        app
          .cliRaw(["client", "connect", `http://127.0.0.1:${deadPort}`], {
            env,
          })
          .fails(1),
    );
    await step("It can't reach the server and keeps the old one", async () => {
      expect(unreachable.stderr).toContain(
        `Could not connect to Dopbase at http://127.0.0.1:${deadPort}`,
      );
      const after = await app
        .cliRaw(["--json", "client", "status"], { env })
        .json();
      expect(after.server_url).toBe(app.url);
    });
    const malformed = await step(
      "dopbase client connect ftp://dopbase.com",
      async () =>
        app
          .cliRaw(["client", "connect", "ftp://dopbase.com"], { env })
          .fails(1),
    );
    await step("It refuses the address", async () => {
      expect(malformed.stderr).toContain(
        "The server address must use http:// or https://",
      );
    });
    const withEnv = await step(
      "dopbase client connect while DOPBASE_URL is set",
      async () =>
        app
          .cliRaw(["client", "connect", app.url], {
            env: { ...env, DOPBASE_URL: app.url },
          })
          .fails(1),
    );
    await step("It says to unset DOPBASE_URL first", async () => {
      expect(withEnv.stderr).toContain("DOPBASE_URL is set");
    });
  },
);

test(
  "client status and the status alias show server, login and default environment",
  {
    tag: "@auth",
    annotation: about(
      "`client status` and `status` agree, show the live server, the root login and the saved default environment.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const viaClient = await step("dopbase --json client status", async () =>
      app.cli(["--json", "client", "status"]).json(),
    );
    const viaAlias = await step("dopbase --json status", async () =>
      app.cli(["--json", "status"]).json(),
    );
    await step("Both show the live server and the root session", async () => {
      expect(viaAlias).toEqual(viaClient);
      expect(viaClient.server_url).toBe(app.url);
      expect(viaClient.server_status).toBe("connected");
      expect(viaClient.status_source).toBe("live");
      expect(viaClient.authentication).toBe("encrypted_session");
      expect(viaClient.identity).toBe("admin");
      expect(viaClient.role).toBe("Root");
      expect(viaClient.email).toBe(ROOT_EMAIL);
    });
    await step(`dopbase env default ${env.ref}`, async () => {
      await app.cli(["env", "default", env.ref]).ok();
    });
    try {
      const human = await step("dopbase status", async () =>
        app.cli(["status"]).stdout(),
      );
      await step(
        "It reads connected (live), Root and the default environment",
        async () => {
          expect(human).toMatch(/Server status:\s+connected \(live\)/);
          expect(human).toMatch(/Role:\s+Root/);
          expect(human).toMatch(new RegExp(`Email:\\s+${ROOT_EMAIL}`));
          expect(human).toMatch(
            new RegExp(`Environment:\\s+${env.id} \\(default\\)`),
          );
        },
      );
    } finally {
      await app.cli(["env", "default", "--clear"]).ok();
    }
    const anonymous = await step(
      "dopbase --json client status with no login",
      async () =>
        app.cli(["--json", "client", "status"], { as: "anonymous" }).json(),
    );
    await step("A signed-out client shows authentication none", async () => {
      expect(anonymous.authentication).toBe("none");
      expect(anonymous.identity).toBe("none");
      expect(anonymous.role).toBeNull();
    });
  },
);

test(
  "login --browser approved through the Admin UI ends signed in",
  {
    tag: "@auth",
    annotation: about(
      "`dopbase login --browser` prints a link and a code; approving the code as the person signs the CLI in as them.",
    ),
  },
  async () => {
    const member = await app.make.user({ role: "Member" });
    const env = await freshClientEnv(app, "login");
    const result = await step(
      "dopbase login --browser, approved by the member in the Admin UI",
      async () => browserLogin(app, env, { account: member }),
    );
    await step("It prints the approval link and says Logged in", async () => {
      expect(result.code).toBe(0);
      expect(result.stderr).toContain(`${app.url}/cli/approve`);
      expect(result.stdout).toContain(`Logged in to ${app.url}.`);
    });
    const status = await step("dopbase --json client status", async () =>
      app.cliRaw(["--json", "client", "status"], { env }).json(),
    );
    await step("Status shows the member's session", async () => {
      expect(status.authentication).toBe("encrypted_session");
      expect(status.email).toBe(member.email);
      expect(status.role).toBe("Member");
    });
  },
);

test(
  "login denied or cancelled ends signed out",
  {
    tag: "@auth",
    annotation: about(
      "A login denied in the Admin UI fails with a message, a login cancelled with Ctrl+C exits 130, and neither saves a session.",
    ),
  },
  async () => {
    test.setTimeout(60_000);
    const env = await freshClientEnv(app, "denied");
    const denied = await step(
      "dopbase login --browser, denied in the Admin UI",
      async () => browserLogin(app, env, { decision: "deny" }),
    );
    await step("It fails and says the request was denied", async () => {
      expect(denied.code).toBe(1);
      expect(denied.stderr).toContain(
        "The login request was denied in the browser.",
      );
    });
    await step("dopbase --json client status shows no login", async () => {
      const status = await app
        .cliRaw(["--json", "client", "status"], { env })
        .json();
      expect(status.authentication).toBe("none");
    });

    const cancelled = await step(
      "dopbase login --browser, then Ctrl+C while it waits",
      async () =>
        pty(["login", "--browser"], {
          env,
          steps: [{ wait: "Waiting for approval.", send: "\x03" }],
        }),
    );
    await step("It exits 130 and says Login cancelled", async () => {
      expect(cancelled.code).toBe(130);
      expect(cancelled.output).toContain("Login cancelled.");
    });
    await step("Still no login is saved", async () => {
      const status = await app
        .cliRaw(["--json", "client", "status"], { env })
        .json();
      expect(status.authentication).toBe("none");
    });
  },
);

test(
  "login --token saves a runner token from standard input",
  {
    tag: "@auth",
    annotation: about(
      "`dopbase login --token` reads a dbs_ token from piped input and saves it, so `run` works with no DOPBASE_TOKEN; an empty or malformed token is refused, and so is any login while DOPBASE_TOKEN is set.",
    ),
  },
  async () => {
    const target = await app.make.environment();
    const value = await app.make.secret(target, "API_KEY");
    const created = await app
      .cli(["--json", "token", "create", target.ref, "--name", "ci"], {
        record: false,
      })
      .json();
    const env = await freshClientEnv(app, "runner-login");

    const saved = await step("printf dbs_… | dopbase login --token", async () =>
      app
        .cliRaw(["login", "--token"], { env, stdin: created.plaintextToken })
        .stdout(),
    );
    await step("It says the runner token was saved", async () => {
      expect(saved).toBe(`Saved a runner token for ${app.url}.`);
    });
    await step(
      "dopbase run -- … reads the secret with the saved token",
      async () => {
        const result = await app
          .cliRaw(["run", target.ref, "--", ...printVar("API_KEY")], { env })
          .stdout();
        expect(result).toBe(value);
      },
    );

    const empty = await step(
      "dopbase login --token with empty input",
      async () =>
        app
          .cliRaw(["login", "--token"], {
            env: await freshClientEnv(app, "empty"),
            stdin: "",
          })
          .fails(1),
    );
    await step("It says the token can't be empty", async () => {
      expect(empty.stderr).toContain("Runner token cannot be empty.");
    });
    const malformed = await step(
      "printf not-a-token | dopbase login --token",
      async () =>
        app
          .cliRaw(["login", "--token"], {
            env: await freshClientEnv(app, "malformed"),
            stdin: "not-a-token",
          })
          .fails(1),
    );
    await step("It asks for a token beginning with dbs_", async () => {
      expect(malformed.stderr).toContain(
        "Enter a Dopbase runner token beginning with dbs_.",
      );
    });
    const shadowed = await step(
      "dopbase login --token while DOPBASE_TOKEN is set",
      async () =>
        app
          .cliRaw(["login", "--token"], {
            env: { ...env, DOPBASE_TOKEN: created.plaintextToken },
            stdin: created.plaintextToken,
          })
          .fails(1),
    );
    await step("It says to unset DOPBASE_TOKEN first", async () => {
      expect(shadowed.stderr).toContain("DOPBASE_TOKEN is set");
    });
  },
);

test(
  "login --browser-open hands the approval link to the browser",
  {
    tag: "@auth",
    annotation: about(
      "`dopbase login --browser-open` opens the approval link with the system browser (here a $BROWSER script that records it) and signs in once the code is approved. Linux only: on macOS it would open a real browser.",
    ),
  },
  async () => {
    test.skip(
      process.platform === "darwin",
      "macOS opens links through LaunchServices and ignores $BROWSER",
    );
    const opened = join(await tempDir(app, "browser"), "opened.txt");
    const browser = await script(
      app,
      "browser",
      `printf '%s' "$1" > '${opened}'`,
    );
    const env = { ...(await freshClientEnv(app, "open")), BROWSER: browser };
    const result = await step(
      "BROWSER=<recorder> dopbase login --browser-open, approved in the Admin UI",
      async () =>
        answerBrowserLogin(
          (run) =>
            app.cliRaw(["login", "--browser-open"], {
              ...run,
              env,
              timeoutMs: 45_000,
            }),
          await app.apiAs(ROOT),
        ),
    );
    await step("It says it opened the link and logged in", async () => {
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("Opened the link in your browser.");
      expect(result.stdout).toContain(`Logged in to ${app.url}.`);
    });
    await step("The browser got the approval link it printed", async () => {
      const link = result.stderr.match(/(http\S+\/cli\/approve\S*)\s/)?.[1];
      expect(link, "approval link printed on stderr").toBeTruthy();
      await expect
        .poll(() => readFile(opened, "utf8").catch(() => ""))
        .toBe(link);
    });
  },
);

test(
  "logout removes the saved login and ends the session",
  {
    tag: "@auth",
    annotation: about(
      "`dopbase logout` ends the session on the server and removes it locally; commands then need a login, and a second logout has nothing to end.",
    ),
  },
  async () => {
    const env = await freshClientEnv(app, "logout");
    await step("dopbase login --browser, approved", async () => {
      const login = await browserLogin(app, env);
      expect(login.code).toBe(0);
    });
    await step("dopbase project list works while signed in", async () => {
      await app.cliRaw(["project", "list"], { env }).ok();
    });
    const refused = await step(
      "dopbase logout with DOPBASE_TOKEN set",
      async () =>
        app
          .cliRaw(["logout"], { env: { ...env, DOPBASE_TOKEN: "dbs_x" } })
          .fails(1),
    );
    await step(
      "It refuses and says how to log out without the token",
      async () => {
        expect(refused.stderr).toContain("DOPBASE_TOKEN is set");
        expect(refused.stderr).toContain("env -u DOPBASE_TOKEN dopbase");
      },
    );
    const out = await step("dopbase logout", async () =>
      app.cliRaw(["logout"], { env }).stdout(),
    );
    await step("It says the session ended on the server", async () => {
      expect(out).toBe(
        `Logged out from ${app.url} and ended the session on the server.`,
      );
    });
    await step("dopbase --json client status shows no login", async () => {
      const status = await app
        .cliRaw(["--json", "client", "status"], { env })
        .json();
      expect(status.authentication).toBe("none");
    });
    const after = await step("dopbase project list after logout", async () =>
      app.cliRaw(["project", "list"], { env }).fails(1),
    );
    await step("It needs a login again", async () => {
      expect(after.stderr).toContain("interactive login requires a terminal");
    });
    const second = await step("dopbase --json logout again", async () =>
      app.cliRaw(["--json", "logout"], { env }).json(),
    );
    await step("There was no session to end", async () => {
      expect(second.server_session).toBe("not_applicable");
      expect(second.authentication).toBe("none");
    });
  },
);

test(
  "--server and DOPBASE_URL override the saved server",
  {
    tag: "@auth",
    annotation: about(
      "`--server` wins over DOPBASE_URL, which wins over the saved server, and `client status` names the source of each.",
    ),
  },
  async () => {
    const deadUrl = `http://127.0.0.1:${await freePort()}`;
    const fromEnv = await step(
      "dopbase --json client status with DOPBASE_URL set",
      async () => app.cli(["--json", "client", "status"]).json(),
    );
    await step("The server comes from the environment", async () => {
      expect(fromEnv.server_url).toBe(app.url);
      expect(fromEnv.server_source).toBe("environment");
    });
    const fromFlag = await step(
      `dopbase --json --server ${deadUrl} client status`,
      async () =>
        app.cli(["--json", "--server", deadUrl, "client", "status"]).json(),
    );
    await step("--server wins and that server is offline", async () => {
      expect(fromFlag.server_url).toBe(deadUrl);
      expect(fromFlag.server_source).toBe("argument");
      expect(fromFlag.server_status).toBe("offline");
    });
    const otherEnv = await step(
      `DOPBASE_URL=${deadUrl} dopbase --json client status`,
      async () =>
        app
          .cli(["--json", "client", "status"], {
            env: { DOPBASE_URL: deadUrl },
          })
          .json(),
    );
    await step(
      "The CLI follows DOPBASE_URL, which has no login and is offline",
      async () => {
        expect(otherEnv.server_url).toBe(deadUrl);
        expect(otherEnv.server_source).toBe("environment");
        expect(otherEnv.server_status).toBe("offline");
        expect(otherEnv.authentication).toBe("none");
      },
    );
    const back = await step(
      `DOPBASE_URL=${deadUrl} dopbase --json --server ${app.url} project list`,
      async () =>
        app
          .cli(["--json", "--server", app.url, "project", "list"], {
            env: { DOPBASE_URL: deadUrl },
          })
          .json(),
    );
    await step(
      "--server wins over DOPBASE_URL, and the saved login for that server works",
      async () => {
        expect(Array.isArray(back)).toBe(true);
      },
    );
  },
);
