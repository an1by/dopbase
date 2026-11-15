import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tempDir } from "../harness/helpers.ts";
import {
  ROOT_EMAIL,
  about,
  expect,
  step,
  test,
  useServer,
} from "../harness/index.ts";
import { pty } from "../harness/terminal.ts";
import { Instance, passwordLogin, writeTemp } from "./support.ts";

const app = useServer();

async function launch(identity: string, passcode: string): Promise<Response> {
  return fetch(`${app.url}/api/v1/auth/launch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity, passcode }),
  });
}

test(
  "admin passcode prints a one-time launch link",
  {
    tag: "@admin",
    annotation: about(
      "`dopbase admin passcode` on the running server's data dir prints a /launch link whose passcode signs root in once; the second use is refused.",
    ),
  },
  async () => {
    const issued = await step(
      `dopbase --json admin passcode ${ROOT_EMAIL}`,
      async () =>
        app
          .cliRaw([
            "--data-dir",
            app.dataDir,
            "--json",
            "admin",
            "passcode",
            ROOT_EMAIL,
          ])
          .json(),
    );
    await step("The link points at /launch with the passcode", async () => {
      expect(issued.email).toBe(ROOT_EMAIL);
      expect(issued.ttlSeconds).toBeGreaterThan(0);
      // The host is the instance's configured public URL.
      expect(issued.url).toMatch(/^https?:\/\/[^/]+\/launch#/);
      expect(issued.url).toContain(
        `/launch#identity=${encodeURIComponent(ROOT_EMAIL)}&passcode=${issued.passcode}`,
      );
    });
    await step(
      "The passcode signs in once and sets a session cookie",
      async () => {
        const first = await launch(ROOT_EMAIL, issued.passcode);
        expect(first.status).toBe(200);
        expect(first.headers.get("set-cookie")).toMatch(/dopbase_session=/);
      },
    );
    await step("Using it again is refused with 401", async () => {
      expect((await launch(ROOT_EMAIL, issued.passcode)).status).toBe(401);
    });
    await step("GET /launch serves the Admin UI", async () => {
      expect(await (await fetch(`${app.url}/launch`)).text()).toContain(
        '<div id="app"></div>',
      );
    });
    const human = await step(
      `dopbase admin passcode ${ROOT_EMAIL} --ttl 60`,
      async () =>
        app
          .cliRaw([
            "--data-dir",
            app.dataDir,
            "admin",
            "passcode",
            ROOT_EMAIL,
            "--ttl",
            "60",
          ])
          .stdout(),
    );
    await step(
      "It reads Launch passcode for root and expires in 60 seconds",
      async () => {
        expect(human).toContain(`Launch passcode for ${ROOT_EMAIL}`);
        expect(human).toContain("in 60 seconds");
        expect(human).toContain("It works once.");
      },
    );
  },
);

test(
  "admin passcode refuses an unknown email and a stopped server",
  {
    tag: "@admin",
    annotation: about(
      "`admin passcode` for an email with no account fails with a clear message, and it refuses when the instance's server isn't running.",
    ),
  },
  async () => {
    const unknown = await step(
      "dopbase admin passcode nobody@dopbase.com",
      async () =>
        app
          .cliRaw([
            "--data-dir",
            app.dataDir,
            "admin",
            "passcode",
            "nobody@dopbase.com",
          ])
          .fails(1),
    );
    await step("It says no account exists with that email", async () => {
      expect(unknown.stderr).toContain("no account exists with that email");
    });

    const instance = await Instance.create(app, "passcode");
    await step("dopbase server setup --email owner@dopbase.com", async () => {
      await instance.setup();
    });
    const stopped = await step(
      "dopbase admin passcode owner@dopbase.com with the server stopped",
      async () =>
        instance.cli(["admin", "passcode", "owner@dopbase.com"]).fails(1),
    );
    await step("It says the server isn't running", async () => {
      expect(stopped.stderr).toContain("the Dopbase server isn't running");
    });
  },
);

test(
  "admin reset-password sets a new password and the old one stops working",
  {
    tag: "@admin",
    annotation: about(
      "`admin reset-password` needs a terminal; typed in one, it writes the new password, and after start the new password signs in and the old one fails.",
    ),
  },
  async () => {
    test.setTimeout(60_000);
    const instance = await Instance.create(app, "reset");
    try {
      const oldPassword = await step(
        "dopbase server setup --email owner@dopbase.com",
        async () => instance.setup(),
      );
      const piped = await step(
        "dopbase admin reset-password owner@dopbase.com with piped input",
        async () =>
          instance
            .cli(["admin", "reset-password", "owner@dopbase.com"])
            .fails(1),
      );
      await step("It refuses without an interactive terminal", async () => {
        expect(piped.stderr).toContain(
          "password reset requires an interactive terminal",
        );
      });
      const missing = await step(
        "dopbase admin reset-password nobody@dopbase.com in a terminal",
        async () =>
          pty(
            [
              "--data-dir",
              instance.dataDir,
              "admin",
              "reset-password",
              "nobody@dopbase.com",
            ],
            { env: instance.env },
          ),
      );
      await step("It says no administrator has that email", async () => {
        expect(missing.code).toBe(1);
        expect(missing.output).toContain(
          "no administrator exists with that email",
        );
      });

      const newPassword = `new-${instance.port}-password-long`;
      const reset = await step(
        "dopbase admin reset-password owner@dopbase.com, typing the new password twice",
        async () =>
          pty(
            [
              "--data-dir",
              instance.dataDir,
              "admin",
              "reset-password",
              "owner@dopbase.com",
            ],
            {
              env: instance.env,
              steps: [
                { wait: "New password:", send: `${newPassword}\r` },
                { wait: "Confirm new password:", send: `${newPassword}\r` },
              ],
            },
          ),
      );
      await step(
        "It says the password was reset and sessions revoked",
        async () => {
          expect(reset.code).toBe(0);
          expect(reset.output).toContain(
            `Password reset on the instance in ${instance.dataDir}.`,
          );
          expect(reset.output).toContain(
            "All sessions on this instance were revoked.",
          );
        },
      );

      await step("dopbase server start --background", async () => {
        await instance
          .cli(["server", "start", "--background", ...instance.listen])
          .ok();
      });
      await step("The new password signs in", async () => {
        expect(
          await passwordLogin(instance.url, "owner@dopbase.com", newPassword),
        ).toBe(200);
      });
      await step("The old password is refused", async () => {
        expect(
          await passwordLogin(instance.url, "owner@dopbase.com", oldPassword),
        ).toBe(401);
      });
    } finally {
      await instance.stop();
    }
  },
);

test(
  "admin factory-reset removes the instance and the next start asks for setup",
  {
    tag: "@admin",
    annotation: about(
      "`admin factory-reset` needs a terminal, the confirmation phrase and the root password; it then removes the data dir, keeps a ZIP backup, and the next start asks for setup again.",
    ),
  },
  async () => {
    test.setTimeout(60_000);
    const instance = await Instance.create(app, "factory");
    const password = await step(
      "dopbase server setup --email owner@dopbase.com",
      async () => instance.setup(),
    );
    const piped = await step(
      "dopbase admin factory-reset with piped input",
      async () => instance.cli(["admin", "factory-reset"]).fails(1),
    );
    await step("It refuses without an interactive terminal", async () => {
      expect(piped.stderr).toContain(
        "factory reset requires an interactive terminal",
      );
    });

    const wrongPhrase = await step(
      "dopbase admin factory-reset, typing the wrong confirmation phrase",
      async () =>
        pty(["--data-dir", instance.dataDir, "admin", "factory-reset"], {
          env: instance.env,
          steps: [
            {
              wait: "Type please-wipe-out-system to continue:",
              send: "no thanks\r",
            },
          ],
        }),
    );
    await step("It cancels and leaves the data dir in place", async () => {
      expect(wrongPhrase.code).toBe(1);
      expect(wrongPhrase.output).toContain(
        "factory reset cancelled: confirmation text did not match",
      );
      expect(existsSync(instance.dataDir)).toBe(true);
    });

    const wrongPassword = await step(
      "dopbase admin factory-reset with the wrong root password",
      async () =>
        pty(["--data-dir", instance.dataDir, "admin", "factory-reset"], {
          env: instance.env,
          steps: [
            {
              wait: "Type please-wipe-out-system to continue:",
              send: "please-wipe-out-system\r",
            },
            { wait: "Root password for owner@dopbase.com:", send: "nope\r" },
          ],
        }),
    );
    await step("It says the root password is incorrect", async () => {
      expect(wrongPassword.code).toBe(1);
      expect(wrongPassword.output).toContain("the root password is incorrect");
      expect(existsSync(instance.dataDir)).toBe(true);
    });

    const reset = await step(
      "dopbase admin factory-reset, typing the phrase and the root password",
      async () =>
        pty(["--data-dir", instance.dataDir, "admin", "factory-reset"], {
          env: instance.env,
          steps: [
            {
              wait: "Type please-wipe-out-system to continue:",
              send: "please-wipe-out-system\r",
            },
            {
              wait: "Root password for owner@dopbase.com:",
              send: `${password}\r`,
            },
          ],
        }),
    );
    await step(
      "It says Factory reset complete and names the backup",
      async () => {
        expect(reset.code).toBe(0);
        expect(reset.output).toContain("Factory reset complete.");
        expect(reset.output).toMatch(/Backup:\s+\S+\.zip/);
      },
    );
    await step(
      "The data dir is gone and a ZIP backup sits next to it",
      async () => {
        expect(existsSync(instance.dataDir)).toBe(false);
        const siblings = await readdir(dirname(instance.dataDir));
        expect(siblings.some((name) => name.endsWith(".zip"))).toBe(true);
      },
    );
    const start = await step(
      "dopbase server start --no-web-ui after the reset",
      async () =>
        instance
          .cli(["server", "start", "--no-web-ui", ...instance.listen], {
            DOPBASE_ROOT_EMAIL: "",
          })
          .fails(1),
    );
    await step("It asks for dopbase server setup again", async () => {
      expect(start.stderr).toContain("dopbase server setup");
    });
  },
);

test(
  "admin commands refuse --server",
  {
    tag: "@admin",
    annotation: about(
      "Offline admin commands work on the local data dir only, so `--server` is refused.",
    ),
  },
  async () => {
    const result = await step(
      `dopbase --server ${app.url} admin passcode ${ROOT_EMAIL}`,
      async () =>
        app
          .cliRaw([
            "--server",
            app.url,
            "--data-dir",
            app.dataDir,
            "admin",
            "passcode",
            ROOT_EMAIL,
          ])
          .fails(1),
    );
    await step("It says --server can't be used with admin", async () => {
      expect(result.stderr).toContain(
        "--server cannot be used with local `dopbase admin` commands",
      );
    });
  },
);

test(
  "admin passcode reads --config for the link and the web UI setting",
  {
    tag: "@admin",
    annotation: about(
      "`admin passcode --config` builds the link from that file's public_url, and a file with web_ui = false makes it refuse, since there is no Admin UI to sign in to.",
    ),
  },
  async () => {
    const publicUrl = "http://dopbase-admin.test:8840";
    const config = await writeTemp(
      app,
      "server.toml",
      `public_url = "${publicUrl}"\n`,
    );
    const issued = await step(
      `dopbase --json admin passcode ${ROOT_EMAIL} --config server.toml`,
      async () =>
        app
          .cliRaw([
            "--data-dir",
            app.dataDir,
            "--json",
            "admin",
            "passcode",
            ROOT_EMAIL,
            "--config",
            config,
          ])
          .json(),
    );
    await step("The link uses the file's public URL", async () => {
      expect(issued.url).toBe(
        `${publicUrl}/launch#identity=${encodeURIComponent(ROOT_EMAIL)}&passcode=${issued.passcode}`,
      );
    });
    await step("The passcode signs root in on the running server", async () => {
      expect((await launch(ROOT_EMAIL, issued.passcode)).status).toBe(200);
    });

    const noUi = await writeTemp(app, "server.toml", "web_ui = false\n");
    const refused = await step(
      `dopbase admin passcode ${ROOT_EMAIL} --config <web_ui = false>`,
      async () =>
        app
          .cliRaw([
            "--data-dir",
            app.dataDir,
            "admin",
            "passcode",
            ROOT_EMAIL,
            "--config",
            noUi,
          ])
          .fails(1),
    );
    await step("It says the Admin UI is turned off", async () => {
      expect(refused.stderr).toContain(
        "the Admin UI is turned off on this server (web_ui = false)",
      );
    });
  },
);

test(
  "--master-key-file keeps the master key outside the data dir",
  {
    tag: "@admin",
    annotation: about(
      "`server setup --master-key-file` writes the key to that path instead of the data dir; `server start` and `admin reset-password` then need the same file, through the flag or `[master_key] path` in a `--config` file.",
    ),
  },
  async () => {
    test.setTimeout(90_000);
    const instance = await Instance.create(app, "key-file");
    const keyFile = join(await tempDir(app, "keys"), "master.key");
    const config = await writeTemp(
      app,
      "server.toml",
      `[master_key]\npath = "${keyFile}"\n`,
    );
    try {
      await step(
        "dopbase server setup --email owner@dopbase.com --master-key-file <keys>/master.key",
        async () => {
          const setup = await instance
            .cli([
              "--json",
              "server",
              "setup",
              "--email",
              "owner@dopbase.com",
              "--master-key-file",
              keyFile,
            ])
            .json();
          expect(setup.initialized).toBe(true);
        },
      );
      await step(
        "The key is at that path and not in the data dir",
        async () => {
          expect(existsSync(keyFile)).toBe(true);
          expect(existsSync(join(instance.dataDir, "master.key"))).toBe(false);
        },
      );

      const missing = await step(
        "dopbase server start --background without --master-key-file",
        async () =>
          instance
            .cli(["server", "start", "--background", ...instance.listen])
            .fails(1),
      );
      await step("It can't find the master key", async () => {
        expect(missing.stderr).toMatch(/master key/i);
      });
      await step(
        "dopbase server start --background --master-key-file <keys>/master.key",
        async () => {
          await instance
            .cli([
              "server",
              "start",
              "--background",
              "--master-key-file",
              keyFile,
              ...instance.listen,
            ])
            .ok();
          expect((await fetch(`${instance.url}/api/v1/health`)).status).toBe(
            200,
          );
        },
      );

      const piped = await step(
        "dopbase admin reset-password owner@dopbase.com --master-key-file <keys>/master.key with piped input",
        async () =>
          instance
            .cli([
              "admin",
              "reset-password",
              "owner@dopbase.com",
              "--master-key-file",
              keyFile,
            ])
            .fails(1),
      );
      await step("It still needs an interactive terminal", async () => {
        expect(piped.stderr).toContain(
          "password reset requires an interactive terminal",
        );
      });
      const noKey = await step(
        "dopbase admin reset-password owner@dopbase.com in a terminal, without the key",
        async () =>
          pty(
            [
              "--data-dir",
              instance.dataDir,
              "admin",
              "reset-password",
              "owner@dopbase.com",
            ],
            { env: instance.env },
          ),
      );
      await step(
        "It fails before asking for a password, with no master key",
        async () => {
          expect(noKey.code).toBe(1);
          expect(noKey.output).not.toContain("New password:");
          expect(noKey.output).toMatch(/master key|master\.key/i);
        },
      );

      const withFlag = `flag-${instance.port}-password-long`;
      const viaFlag = await step(
        "dopbase admin reset-password owner@dopbase.com --master-key-file <keys>/master.key in a terminal",
        async () =>
          pty(
            [
              "--data-dir",
              instance.dataDir,
              "admin",
              "reset-password",
              "owner@dopbase.com",
              "--master-key-file",
              keyFile,
            ],
            {
              env: instance.env,
              steps: [
                { wait: "New password:", send: `${withFlag}\r` },
                { wait: "Confirm new password:", send: `${withFlag}\r` },
              ],
            },
          ),
      );
      await step("It resets the password", async () => {
        expect(viaFlag.code).toBe(0);
        expect(viaFlag.output).toContain(
          "All sessions on this instance were revoked.",
        );
        expect(
          await passwordLogin(instance.url, "owner@dopbase.com", withFlag),
        ).toBe(200);
      });

      const withConfig = `config-${instance.port}-password-long`;
      const viaConfig = await step(
        "dopbase admin reset-password owner@dopbase.com --config <[master_key] path> in a terminal",
        async () =>
          pty(
            [
              "--data-dir",
              instance.dataDir,
              "admin",
              "reset-password",
              "owner@dopbase.com",
              "--config",
              config,
            ],
            {
              env: instance.env,
              steps: [
                { wait: "New password:", send: `${withConfig}\r` },
                { wait: "Confirm new password:", send: `${withConfig}\r` },
              ],
            },
          ),
      );
      await step(
        "The key path from the file works too, and only the newest password signs in",
        async () => {
          expect(viaConfig.code).toBe(0);
          expect(
            await passwordLogin(instance.url, "owner@dopbase.com", withConfig),
          ).toBe(200);
          expect(
            await passwordLogin(instance.url, "owner@dopbase.com", withFlag),
          ).toBe(401);
        },
      );
    } finally {
      await instance.stop();
    }
  },
);

test(
  "admin factory-reset --no-backup removes the instance without a ZIP, and reads --config",
  {
    tag: "@admin",
    annotation: about(
      "`admin factory-reset --config` with an invalid file stops before touching anything; with `--no-backup` the confirmed reset removes the data dir and leaves no ZIP next to it.",
    ),
  },
  async () => {
    test.setTimeout(60_000);
    const instance = await Instance.create(app, "no-backup");
    const password = await step(
      "dopbase server setup --email owner@dopbase.com",
      async () => instance.setup(),
    );
    const badConfig = await writeTemp(
      app,
      "server.toml",
      "shutdown_grace_seconds = 0\n",
    );
    const invalid = await step(
      "dopbase admin factory-reset --config <invalid server.toml> in a terminal",
      async () =>
        pty(
          [
            "--data-dir",
            instance.dataDir,
            "admin",
            "factory-reset",
            "--config",
            badConfig,
          ],
          { env: instance.env },
        ),
    );
    await step(
      "It rejects the file and leaves the data dir in place",
      async () => {
        expect(invalid.code).toBe(1);
        expect(invalid.output).toContain(
          "shutdown_grace_seconds must be between 1 and 300",
        );
        expect(existsSync(instance.dataDir)).toBe(true);
      },
    );

    const piped = await step(
      "dopbase admin factory-reset --no-backup with piped input",
      async () =>
        instance.cli(["admin", "factory-reset", "--no-backup"]).fails(1),
    );
    await step("It refuses without an interactive terminal", async () => {
      expect(piped.stderr).toContain(
        "factory reset requires an interactive terminal",
      );
    });

    const reset = await step(
      "dopbase admin factory-reset --no-backup, typing the phrase and the root password",
      async () =>
        pty(
          [
            "--data-dir",
            instance.dataDir,
            "admin",
            "factory-reset",
            "--no-backup",
          ],
          {
            env: instance.env,
            steps: [
              {
                wait: "Type please-wipe-out-system to continue:",
                send: "please-wipe-out-system\r",
              },
              {
                wait: "Root password for owner@dopbase.com:",
                send: `${password}\r`,
              },
            ],
          },
        ),
    );
    await step("It says the backup was skipped", async () => {
      expect(reset.code).toBe(0);
      expect(reset.output).toContain("Factory reset complete.");
      expect(reset.output).toMatch(/Backup:\s+skipped \(--no-backup\)/);
    });
    await step("The data dir is gone and no ZIP was written", async () => {
      expect(existsSync(instance.dataDir)).toBe(false);
      const siblings = await readdir(dirname(instance.dataDir));
      expect(siblings.filter((name) => name.endsWith(".zip"))).toEqual([]);
    });
  },
);
