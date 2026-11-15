import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiClient } from "../harness/api.ts";
import {
  about,
  expect,
  ROOT,
  step,
  test,
  useServer,
} from "../harness/index.ts";
import { startServer } from "../harness/server.ts";
import { pty } from "../harness/terminal.ts";
import { Instance, passwordLogin, writeTemp } from "./support.ts";

// Each test gets its own data dir, HOME and port; the file's shared server
// is only there to satisfy useServer().
const app = useServer();

test(
  "a fresh start without setup refuses and points to server setup",
  {
    tag: ["@smoke", "@server"],
    annotation: about(
      "With the web UI off and no root email, `server start` (foreground and --background) exits 1, names `dopbase server setup` and creates no data dir.",
    ),
  },
  async () => {
    const instance = await Instance.create(app, "fresh");
    try {
      const foreground = await step(
        "dopbase server start --no-web-ui on an empty data dir",
        async () =>
          instance
            .cli(["server", "start", "--no-web-ui", ...instance.listen], {
              DOPBASE_ROOT_EMAIL: "",
            })
            .fails(1),
      );
      await step("It says the instance needs setup", async () => {
        expect(foreground.stderr).toContain(
          "This instance needs setup before it can start.",
        );
        expect(foreground.stderr).toContain("dopbase server setup");
      });
      await step("No data dir was created", async () => {
        expect(existsSync(instance.dataDir)).toBe(false);
      });

      const background = await step(
        "dopbase server start --background --no-web-ui",
        async () =>
          instance
            .cli(
              [
                "server",
                "start",
                "--background",
                "--no-web-ui",
                ...instance.listen,
              ],
              { DOPBASE_ROOT_EMAIL: "" },
            )
            .fails(1),
      );
      await step(
        "It refuses the same way and still creates nothing",
        async () => {
          expect(background.stderr).toContain("dopbase server setup");
          expect(existsSync(instance.dataDir)).toBe(false);
        },
      );

      const json = await step(
        "dopbase --json server start --background --no-web-ui",
        async () =>
          instance
            .cli(
              [
                "--json",
                "server",
                "start",
                "--background",
                "--no-web-ui",
                ...instance.listen,
              ],
              { DOPBASE_ROOT_EMAIL: "" },
            )
            .fails(1),
      );
      await step("The JSON answer has code SETUP_REQUIRED", async () => {
        const body = JSON.parse(json.stdout);
        expect(body.success).toBe(false);
        expect(body.info.code).toBe("SETUP_REQUIRED");
      });
    } finally {
      await instance.stop();
    }
  },
);

test(
  "a fresh start with the web UI prints a setup token that claims root",
  {
    tag: ["@smoke", "@server"],
    annotation: about(
      "A fresh foreground `server start` creates its data dir, logs the config path and a setup token, and claiming root with that token makes bootstrap ready.",
    ),
  },
  async () => {
    const instance = await Instance.create(app, "bootstrap");
    try {
      const server = await step(
        "dopbase server start on an empty data dir",
        async () => instance.startForeground(),
      );
      const log = await step(
        "The log shows the data dir and a setup token",
        async () => {
          let text = "";
          await expect
            .poll(async () => (text = await server.log()))
            .toMatch(/^setup_\S+/m);
          expect(text).toContain(`Config:     ${instance.dataDir}`);
          expect(text).toContain("Dopbase setup token");
          return text;
        },
      );
      await step(
        "The data dir holds dopbase.db, master.key and the lock file",
        async () => {
          for (const name of ["dopbase.db", "master.key", "dopbase.db.lock"]) {
            expect(existsSync(join(instance.dataDir, name)), name).toBe(true);
          }
        },
      );
      await step(
        "POST /api/v1/bootstrap/admin with the token, then bootstrap status is ready",
        async () => {
          const token = log.match(/^setup_\S+/m)![0];
          const claim = await fetch(`${instance.url}/api/v1/bootstrap/admin`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              setupToken: token,
              email: "smoke@dopbase.com",
              password: "fixture-password-123",
            }),
          });
          expect(claim.status).toBe(201);
          const status = await (
            await fetch(`${instance.url}/api/v1/bootstrap/status`)
          ).json();
          expect(status.data.state).toBe("ready");
        },
      );
    } finally {
      await instance.stop();
    }
  },
);

test(
  "server setup, then server start serves the API, the UI and the docs",
  {
    tag: ["@smoke", "@server"],
    annotation: about(
      "`server setup --email` initializes the instance without a server; a foreground `server start --docs` then answers health and serves the SPA, openapi.json and /api/docs.",
    ),
  },
  async () => {
    const instance = await Instance.create(app, "setup");
    try {
      const setup = await step(
        "dopbase --json server setup --email owner@dopbase.com",
        async () =>
          instance
            .cli(["--json", "server", "setup", "--email", "owner@dopbase.com"])
            .json(),
      );
      await step(
        "The answer has the email, the data dir and a generated password",
        async () => {
          expect(setup.initialized).toBe(true);
          expect(setup.email).toBe("owner@dopbase.com");
          expect(setup.data_dir).toBe(instance.dataDir);
          expect(setup.password).toMatch(/\S{16,}/);
        },
      );
      const again = await step("dopbase server setup a second time", async () =>
        instance
          .cli(["server", "setup", "--email", "owner@dopbase.com"])
          .fails(1),
      );
      await step("It refuses because the instance is set up", async () => {
        expect(again.stderr).toMatch(/already|initialized/i);
      });

      await step("dopbase server start --docs (foreground)", async () => {
        await instance.startForeground(["--docs"]);
      });
      await step("GET /api/v1/health answers success", async () => {
        const health = await (
          await fetch(`${instance.url}/api/v1/health`)
        ).json();
        expect(health.success).toBe(true);
      });
      await step("GET / serves the Admin UI index", async () => {
        const index = await fetch(`${instance.url}/`);
        expect(index.status).toBe(200);
        expect(await index.text()).toContain('<div id="app"></div>');
      });
      await step(
        "GET /api/v1/openapi.json is the OpenAPI document",
        async () => {
          const spec = await (
            await fetch(`${instance.url}/api/v1/openapi.json`)
          ).json();
          expect(spec.openapi).toMatch(/^3\./);
        },
      );
      await step("GET /api/docs/ serves Swagger UI", async () => {
        const docs = await fetch(`${instance.url}/api/docs/`);
        expect(docs.status).toBe(200);
      });
      await step(
        "The generated password signs in; the server is ready",
        async () => {
          expect(
            await passwordLogin(
              instance.url,
              "owner@dopbase.com",
              setup.password,
            ),
          ).toBe(200);
        },
      );
    } finally {
      await instance.stop();
    }
  },
);

test(
  "--no-web-ui serves the API but not the Admin UI",
  {
    tag: ["@smoke", "@server"],
    annotation: about(
      "A set-up instance started with `--no-web-ui` answers the API and returns no SPA at /.",
    ),
  },
  async () => {
    const instance = await Instance.create(app, "no-ui");
    try {
      await step("dopbase server setup --email owner@dopbase.com", async () => {
        await instance.setup();
      });
      const started = await step(
        "dopbase --json server start --background --no-web-ui",
        async () =>
          instance
            .cli([
              "--json",
              "server",
              "start",
              "--background",
              "--no-web-ui",
              ...instance.listen,
            ])
            .json(),
      );
      await step("It reports the server started", async () => {
        expect(started.started).toBe(true);
      });
      await step("GET /api/v1/health answers success", async () => {
        const health = await fetch(`${instance.url}/api/v1/health`);
        expect(health.status).toBe(200);
      });
      await step("GET / does not serve the Admin UI", async () => {
        const index = await fetch(`${instance.url}/`);
        expect(await index.text()).not.toContain('<div id="app"></div>');
      });
    } finally {
      await instance.stop();
    }
  },
);

test(
  "background start, status, logs, restart and stop",
  {
    tag: ["@smoke", "@server"],
    annotation: about(
      "A background server with DOPBASE_ROOT_EMAIL sets itself up, shows in `server status --json` and `server logs`, keeps its credentials across `server restart`, never writes the password to its log, and `server stop` leaves status stopped.",
    ),
  },
  async () => {
    test.setTimeout(60_000);
    const instance = await Instance.create(app, "background");
    try {
      const started = await step(
        "DOPBASE_ROOT_EMAIL=owner@dopbase.com dopbase --json server start --background --docs",
        async () =>
          instance
            .cli(
              [
                "--json",
                "server",
                "start",
                "--background",
                "--docs",
                ...instance.listen,
              ],
              { DOPBASE_ROOT_EMAIL: "owner@dopbase.com" },
            )
            .json(),
      );
      const password: string = started.setup?.password;
      await step(
        "The answer has the pid, the log file and the one-time setup",
        async () => {
          expect(started.started).toBe(true);
          expect(started.pid).toBeGreaterThan(0);
          expect(started.stop_command).toBe("dopbase server stop");
          expect(started.setup.initialized).toBe(true);
          expect(started.setup.email).toBe("owner@dopbase.com");
          expect(password).toMatch(/\S{16,}/);
        },
      );
      await step("GET /api/v1/health answers success", async () => {
        const health = await (
          await fetch(`${instance.url}/api/v1/health`)
        ).json();
        expect(health.success).toBe(true);
      });
      await step("The password never appears in the daemon log", async () => {
        const log = await readFile(started.log_file, "utf8");
        expect(log).not.toContain(password);
        expect(log).not.toContain("Password (shown once)");
      });

      const status = await step("dopbase --json server status", async () =>
        instance.cli(["--json", "server", "status"]).json(),
      );
      await step("Status is running in the background", async () => {
        expect(status.status).toBe("running");
        expect(status.mode).toBe("background");
        expect(status.pid).toBe(started.pid);
        expect(status.public_url).toBe(instance.url);
      });
      const human = await step("dopbase server status", async () =>
        instance.cli(["server", "status"]).stdout(),
      );
      await step("It reads Server: running (background)", async () => {
        expect(human).toContain("Server:     running (background)");
        expect(human).toContain(`URL:        ${instance.url}`);
      });

      const logs = await step(
        "dopbase --json server logs --lines 5",
        async () =>
          instance.cli(["--json", "server", "logs", "--lines", "5"]).json(),
      );
      await step("At most 5 lines come back from the log file", async () => {
        expect(logs.log_file).toBe(started.log_file);
        expect(logs.lines.length).toBeGreaterThan(0);
        expect(logs.lines.length).toBeLessThanOrEqual(5);
      });
      await step("dopbase server logs --lines 5 prints them", async () => {
        const text = await instance
          .cli(["server", "logs", "--lines", "5"])
          .stdout();
        expect(text.split("\n").length).toBeLessThanOrEqual(5);
      });

      const restarted = await step("dopbase --json server restart", async () =>
        instance.cli(["--json", "server", "restart"]).json(),
      );
      await step(
        "It restarts with a new pid and generates no new credentials",
        async () => {
          expect(restarted.restarted).toBe(true);
          expect(restarted.previous_pid).toBe(started.pid);
          expect(restarted.pid).not.toBe(started.pid);
          expect(restarted).not.toHaveProperty("setup");
        },
      );
      await step("The same password still signs in", async () => {
        await expect
          .poll(() =>
            passwordLogin(instance.url, "owner@dopbase.com", password),
          )
          .toBe(200);
      });

      const stopped = await step("dopbase server stop", async () =>
        instance.cli(["server", "stop"]).stdout(),
      );
      await step("It says the server stopped", async () => {
        expect(stopped).toBe("Dopbase server stopped successfully.");
      });
      const after = await step("dopbase --json server status", async () =>
        instance.cli(["--json", "server", "status"]).fails(1),
      );
      await step("Status reports stopped and exits 1", async () => {
        const body = JSON.parse(after.stdout);
        expect(body.status).toBe("stopped");
        expect(body.mode).toBeNull();
      });
      const again = await step("dopbase server stop again", async () =>
        instance.cli(["server", "stop"]).fails(1),
      );
      await step("It says no daemon is running", async () => {
        expect(again.stderr).toContain("no running Dopbase daemon");
      });
    } finally {
      await instance.stop();
    }
  },
);

test(
  "restart and logs refuse when no background server runs",
  {
    tag: "@server",
    annotation: about(
      "`server restart` on a stopped instance names `server start --background`, and `server logs` with no log file fails.",
    ),
  },
  async () => {
    const instance = await Instance.create(app, "stopped");
    await step("dopbase server setup --email owner@dopbase.com", async () => {
      await instance.setup();
    });
    const restart = await step("dopbase server restart", async () =>
      instance.cli(["server", "restart"]).fails(1),
    );
    await step("It says to start it with --background", async () => {
      expect(restart.stderr).toContain(
        "Start it with `dopbase server start --background`",
      );
    });
    const logs = await step("dopbase server logs", async () =>
      instance.cli(["server", "logs"]).fails(1),
    );
    await step("It says there is no background server log", async () => {
      expect(logs.stderr).toContain("no background server log found");
    });
    const status = await step("dopbase server status", async () =>
      instance.cli(["server", "status"]).fails(1),
    );
    await step("Status reads Server: stopped", async () => {
      expect(status.stdout).toContain("Server:     stopped");
    });
  },
);

test(
  "server setup takes listener options only with --web",
  {
    tag: "@server",
    annotation: about(
      "CLI setup starts no server, so `--port`, `--no-docs` and `--shutdown-grace-seconds` are refused without `--web`, and `--web` refuses `--json`; none of them creates the data dir.",
    ),
  },
  async () => {
    const instance = await Instance.create(app, "setup-flags");
    for (const flags of [
      ["--port", String(instance.port)],
      ["--no-docs"],
      ["--shutdown-grace-seconds", "5"],
    ]) {
      const refused = await step(
        `dopbase server setup --email owner@dopbase.com ${flags.join(" ")}`,
        async () =>
          instance
            .cli(["server", "setup", "--email", "owner@dopbase.com", ...flags])
            .fails(1),
      );
      await step("It says listener options need --web", async () => {
        expect(refused.stderr).toContain(
          "listener options require `dopbase server setup --web`",
        );
      });
    }
    const json = await step("dopbase --json server setup --web", async () =>
      instance.cli(["--json", "server", "setup", "--web"]).fails(1),
    );
    await step("It says --json can't be used with --web", async () => {
      expect(json.stderr).toContain(
        "--json cannot be used with `dopbase server setup --web`",
      );
    });
    await step("No data dir was created", async () => {
      expect(existsSync(instance.dataDir)).toBe(false);
    });
  },
);

test(
  "server setup --web serves the setup page with the email filled in",
  {
    tag: "@server",
    annotation: about(
      "`server setup --web --email` runs a setup server that prints a setup link carrying the token and the email, serves the Admin UI but no docs with `--no-docs`, and claiming root through it sets the instance up.",
    ),
  },
  async () => {
    test.setTimeout(60_000);
    const instance = await Instance.create(app, "setup-web");
    const abort = new AbortController();
    let seen!: (link: string) => void;
    const printed = new Promise<string>((done) => (seen = done));
    const run = app.cliRaw(
      [
        "--data-dir",
        instance.dataDir,
        "server",
        "setup",
        "--web",
        "--email",
        "owner@dopbase.com",
        "--no-docs",
        "--shutdown-grace-seconds",
        "2",
        ...instance.listen,
      ],
      {
        env: { ...instance.env, DOPBASE_ROOT_EMAIL: "" },
        signal: abort.signal,
        timeoutMs: 45_000,
        onStderr: (text) => {
          const link = text.match(/(http\S+\/setup\?token=\S+)\s/)?.[1];
          if (link) seen(link);
        },
      },
    );
    try {
      const link = await step(
        "dopbase server setup --web --email owner@dopbase.com --no-docs --shutdown-grace-seconds 2",
        async () =>
          Promise.race([
            printed,
            Promise.resolve(run).then((result): never => {
              throw new Error(
                `setup --web exited ${result.code} before printing a link:\n${result.stderr}`,
              );
            }),
          ]),
      );
      const url = new URL(link);
      await step("The link carries the setup token and the email", async () => {
        expect(url.origin).toBe(instance.url);
        expect(url.searchParams.get("token")).toMatch(/^setup_\S+/);
        expect(url.searchParams.get("email")).toBe("owner@dopbase.com");
      });
      await step("GET /api/v1/bootstrap/status asks for setup", async () => {
        const status = await (
          await fetch(`${instance.url}/api/v1/bootstrap/status`)
        ).json();
        expect(status.data.state).toBe("setupRequired");
      });
      await step(
        "GET / serves the Admin UI and /api/docs/ is off",
        async () => {
          const index = await fetch(`${instance.url}/`);
          expect(await index.text()).toContain('<div id="app"></div>');
          expect((await fetch(`${instance.url}/api/docs/`)).status).toBe(404);
        },
      );
      await step(
        "POST /api/v1/bootstrap/admin with the token claims root",
        async () => {
          const claim = await fetch(`${instance.url}/api/v1/bootstrap/admin`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              setupToken: url.searchParams.get("token"),
              email: "owner@dopbase.com",
              password: "fixture-password-123",
            }),
          });
          expect(claim.status).toBe(201);
        },
      );
    } finally {
      abort.abort();
      await run;
    }
    const again = await step(
      "dopbase server setup --email owner@dopbase.com after the web setup",
      async () =>
        instance
          .cli(["server", "setup", "--email", "owner@dopbase.com"])
          .fails(1),
    );
    await step("It refuses because the instance is set up", async () => {
      expect(again.stderr).toMatch(/already|initialized/i);
    });
  },
);

test(
  "server start reads --config from outside the data dir, and flags win over it",
  {
    tag: "@server",
    annotation: about(
      "A server.toml passed with `--config` sets the port, the public URL and docs; `--no-docs` turns the docs off for one run, and `--shutdown-grace-seconds` outside 1 to 300 is refused.",
    ),
  },
  async () => {
    test.setTimeout(90_000);
    const instance = await Instance.create(app, "config");
    const config = await writeTemp(
      app,
      "server.toml",
      [
        `port = ${instance.port}`,
        `public_url = "${instance.url}"`,
        "docs = true",
        "shutdown_grace_seconds = 5",
        "",
      ].join("\n"),
    );
    try {
      await step(
        "dopbase server setup --config server.toml --email owner@dopbase.com",
        async () => {
          const setup = await instance
            .cli([
              "--json",
              "server",
              "setup",
              "--config",
              config,
              "--email",
              "owner@dopbase.com",
            ])
            .json();
          expect(setup.initialized).toBe(true);
        },
      );
      await step(
        "dopbase server start --background --config server.toml",
        async () => {
          const started = await instance
            .cli([
              "--json",
              "server",
              "start",
              "--background",
              "--config",
              config,
            ])
            .json();
          expect(started.started).toBe(true);
        },
      );
      await step(
        "It listens on the file's port and serves /api/docs/",
        async () => {
          const health = await fetch(`${instance.url}/api/v1/health`);
          expect(health.status).toBe(200);
          expect((await fetch(`${instance.url}/api/docs/`)).status).toBe(200);
        },
      );
      await step("server status shows the file's public URL", async () => {
        const status = await instance
          .cli(["--json", "server", "status"])
          .json();
        expect(status.public_url).toBe(instance.url);
      });
      await step("dopbase server stop", async () => {
        await instance.cli(["server", "stop"]).ok();
      });

      await step(
        "dopbase server start --background --config server.toml --no-docs",
        async () => {
          await instance
            .cli([
              "server",
              "start",
              "--background",
              "--config",
              config,
              "--no-docs",
            ])
            .ok();
        },
      );
      await step(
        "The API answers but /api/docs/ is off for this run",
        async () => {
          expect((await fetch(`${instance.url}/api/v1/health`)).status).toBe(
            200,
          );
          expect((await fetch(`${instance.url}/api/docs/`)).status).toBe(404);
        },
      );
      await step("dopbase server stop", async () => {
        await instance.cli(["server", "stop"]).ok();
      });

      for (const seconds of ["0", "301"]) {
        const refused = await step(
          `dopbase server start --background --config server.toml --shutdown-grace-seconds ${seconds}`,
          async () =>
            instance
              .cli([
                "server",
                "start",
                "--background",
                "--config",
                config,
                "--shutdown-grace-seconds",
                seconds,
              ])
              .fails(1),
        );
        await step("It says the value must be 1 to 300", async () => {
          expect(refused.stderr).toContain(
            "shutdown_grace_seconds must be between 1 and 300",
          );
        });
      }
      await step(
        "dopbase server start --background --config server.toml --shutdown-grace-seconds 1",
        async () => {
          const started = await instance
            .cli([
              "--json",
              "server",
              "start",
              "--background",
              "--config",
              config,
              "--shutdown-grace-seconds",
              "1",
            ])
            .json();
          expect(started.started).toBe(true);
        },
      );
      await step("dopbase server stop stops it", async () => {
        expect(await instance.cli(["server", "stop"]).stdout()).toBe(
          "Dopbase server stopped successfully.",
        );
      });
    } finally {
      await instance.stop();
    }
  },
);

test(
  "server logs --clean empties the log and --watch follows new lines",
  {
    tag: "@server",
    annotation: about(
      "`server logs --clean` truncates the background server's log, `--watch` prints lines written after it starts, `--json` can't watch, and Ctrl+C ends a watch with exit 0.",
    ),
  },
  async () => {
    test.setTimeout(60_000);
    const instance = await Instance.create(app, "logs");
    try {
      await step("dopbase server setup --email owner@dopbase.com", async () => {
        await instance.setup();
      });
      const started = await step(
        "dopbase --json server start --background",
        async () =>
          instance
            .cli([
              "--json",
              "server",
              "start",
              "--background",
              ...instance.listen,
            ])
            .json(),
      );
      const before = await step("dopbase --json server logs", async () =>
        instance.cli(["--json", "server", "logs"]).json(),
      );
      await step("The log holds the start-up lines", async () => {
        expect(before.lines.join("\n")).toContain("Dopbase server started");
      });

      const cleaned = await step("dopbase server logs --clean", async () =>
        instance.cli(["server", "logs", "--clean"]).stdout(),
      );
      await step("It says the log was cleared", async () => {
        expect(cleaned).toBe("Background server log cleared.");
      });
      await step("The start-up lines are gone", async () => {
        const after = await instance.cli(["--json", "server", "logs"]).json();
        expect(after.lines.join("\n")).not.toContain("Dopbase server started");
      });
      await step("dopbase --json server logs --clean", async () => {
        const json = await instance
          .cli(["--json", "server", "logs", "--clean"])
          .json();
        expect(json.cleaned).toBe(true);
        expect(json.log_file).toBe(started.log_file);
      });

      const jsonWatch = await step(
        "dopbase --json server logs --watch",
        async () =>
          instance.cli(["--json", "server", "logs", "--watch"]).fails(1),
      );
      await step("It says --json can't watch", async () => {
        expect(jsonWatch.stderr).toContain(
          "--json cannot be used with `dopbase server logs --watch`",
        );
      });

      const existing = `e2e-before-${instance.port}`;
      const marker = `e2e-watch-${instance.port}`;
      await appendFile(started.log_file, `${existing}\n`);
      const watched = await step(
        "dopbase server logs --watch, while a line is added to the log",
        async () => {
          const abort = new AbortController();
          // Seeing the tail means the watch has read the file, so a line
          // appended after that can only come from the follow loop.
          let tailed!: () => void;
          let followed!: () => void;
          const tail = new Promise<void>((done) => (tailed = done));
          const follow = new Promise<void>((done) => (followed = done));
          const run = app.cliRaw(
            ["--data-dir", instance.dataDir, "server", "logs", "--watch"],
            {
              env: instance.env,
              signal: abort.signal,
              timeoutMs: 30_000,
              onStdout: (text) => {
                if (text.includes(existing)) tailed();
                if (text.includes(marker)) followed();
              },
            },
          );
          const exited = Promise.resolve(run).then((result): never => {
            throw new Error(
              `logs --watch exited ${result.code} early:\n${result.stderr}`,
            );
          });
          try {
            await Promise.race([tail, exited]);
            await appendFile(started.log_file, `${marker}\n`);
            await Promise.race([follow, exited]);
          } finally {
            abort.abort();
          }
          return run;
        },
      );
      await step("It printed the old tail, then the new line", async () => {
        expect(watched.stdout.indexOf(existing)).toBeGreaterThanOrEqual(0);
        expect(watched.stdout.indexOf(marker)).toBeGreaterThan(
          watched.stdout.indexOf(existing),
        );
      });

      const interrupted = await step(
        "dopbase server logs --clean --watch, then Ctrl+C",
        async () =>
          pty(
            [
              "--data-dir",
              instance.dataDir,
              "server",
              "logs",
              "--clean",
              "--watch",
            ],
            {
              env: instance.env,
              steps: [{ wait: "Waiting for new output.", send: "\x03" }],
            },
          ),
      );
      await step("It cleared the log and Ctrl+C exits 0", async () => {
        expect(interrupted.code).toBe(0);
        expect(interrupted.output).toContain("Background server log cleared.");
        expect(await readFile(started.log_file, "utf8")).not.toContain(marker);
      });
    } finally {
      await instance.stop();
    }
  },
);

test(
  "settings that need RBAC warn at start when it is off",
  {
    tag: "@server",
    annotation: about(
      "DOPBASE_RBAC_ROLES and DOPBASE_RBAC_MAX_USERS do nothing without DOPBASE_RBAC, so the server says so when it starts and keeps custom roles off (403 FEATURE_DISABLED).",
    ),
  },
  async () => {
    const server = await step(
      "Start with DOPBASE_RBAC_ROLES=true and DOPBASE_RBAC_MAX_USERS=2, without DOPBASE_RBAC",
      async () =>
        startServer({
          env: { DOPBASE_RBAC_ROLES: "true", DOPBASE_RBAC_MAX_USERS: "2" },
        }),
    );
    try {
      await step("The start output warns about both settings", async () => {
        const log = await server.log();
        expect(log).toContain(
          "DOPBASE_RBAC_ROLES is on but DOPBASE_RBAC is off, so custom roles stay off.",
        );
        expect(log).toContain(
          "DOPBASE_RBAC_MAX_USERS is set but DOPBASE_RBAC is off, so it does nothing.",
        );
      });
      await step("POST /roles is 403 FEATURE_DISABLED", async () => {
        const api = await ApiClient.signIn(server.url, ROOT);
        const result = await api.post("/roles", {
          name: "Releaser",
          description: "Ships releases.",
          maxLevel: "write",
          capabilities: ["audit.read", "tokens.personal"],
        });
        expect(result.status).toBe(403);
        expect(Object.keys(result.body?.error ?? {})).toContain(
          "FEATURE_DISABLED",
        );
        await api.dispose();
      });
    } finally {
      await server.stop();
    }
  },
);
