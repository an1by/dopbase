import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { printVar, tempDir } from "../harness/helpers.ts";
import { about, expect, step, test, useServer } from "../harness/index.ts";
import { startServer, type Server } from "../harness/server.ts";

const app = useServer();

/** A fresh server that was never set up, stopped after `body`. */
async function withUninitialized<T>(
  body: (server: Server) => Promise<T>,
): Promise<T> {
  const server = await startServer({ claimRoot: false });
  try {
    return await body(server);
  } finally {
    await server.stop();
  }
}

async function bootstrapState(url: string): Promise<string> {
  const status = await (await fetch(`${url}/api/v1/bootstrap/status`)).json();
  return status.data.state;
}

test(
  "backup writes an encrypted .dop file",
  {
    tag: "@backup",
    annotation: about(
      "`dopbase backup --output` saves a .dop snapshot on the server and downloads it; the file holds no secret value in plain text.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const value = await app.make.secret(env, "API_KEY");
    const path = join(await tempDir(app, "backup"), "snapshot.dop");
    const result = await step(
      "dopbase --json backup snapshot --output snapshot.dop",
      async () =>
        app.cli(["--json", "backup", "snapshot", "--output", path]).json(),
    );
    await step(
      "It names the backup on the server and the local copy",
      async () => {
        expect(result.key).toMatch(/\.dop$/);
        expect(result.size).toBeGreaterThan(0);
        expect(result.localPath).toBe(path);
        expect(existsSync(path)).toBe(true);
      },
    );
    await step("The secret value doesn't appear in the file", async () => {
      const bytes = await readFile(path);
      expect(bytes.includes(Buffer.from(value))).toBe(false);
    });
    const human = await step("dopbase backup", async () =>
      app.cli(["backup"]).ok(),
    );
    await step(
      "It says Backup complete and warns about the master key",
      async () => {
        expect(human.stdout).toContain("Backup complete.");
        expect(human.stdout).toMatch(/Filename:\s+dopbase_backup_\S+\.dop/);
        // The warning goes to stderr.
        expect(human.stderr).toContain(
          "Warning: This backup uses the instance master key. Restoring it on another server requires both files.",
        );
      },
    );
    const again = await step(
      "dopbase backup snapshot --output snapshot.dop again",
      async () => app.cli(["backup", "snapshot2", "--output", path]).fails(1),
    );
    await step("It won't overwrite the local file", async () => {
      expect(again.stderr).toMatch(/exists/);
    });
  },
);

test(
  "restore with the master key brings back projects and secrets",
  {
    tag: "@backup",
    annotation: about(
      "Restoring a backup onto a fresh server with `--key` and `--setup-token` sets it up with the same projects, and a runner token from the backup reads the same secret there.",
    ),
  },
  async () => {
    test.setTimeout(60_000);
    const env = await app.make.environment();
    const value = await app.make.secret(env, "API_KEY");
    const token = (
      await app
        .cli(["--json", "token", "create", env.ref, "--name", "ci"])
        .json()
    ).plaintextToken;
    const path = join(await tempDir(app, "restore"), "snapshot.dop");
    await step("dopbase backup <name> --output snapshot.dop", async () => {
      await app.cli(["backup", app.uniq("restore"), "--output", path]).ok();
    });
    await withUninitialized(async (target) => {
      const missingToken = await step(
        "dopbase restore snapshot.dop --key master.key --yes without a setup token",
        async () =>
          app
            .cli([
              "--server",
              target.url,
              "restore",
              path,
              "--key",
              join(app.dataDir, "master.key"),
              "--yes",
            ])
            .fails(1),
      );
      await step("It asks for --setup-token", async () => {
        expect(missingToken.stderr).toContain("--setup-token is required");
      });
      const restored = await step(
        "dopbase restore snapshot.dop --key master.key --setup-token setup_… --yes",
        async () =>
          app
            .cli([
              "--server",
              target.url,
              "restore",
              path,
              "--key",
              join(app.dataDir, "master.key"),
              "--setup-token",
              target.setupToken!,
              "--yes",
            ])
            .stdout(),
      );
      await step(
        "It says Restore complete and the server is initialized",
        async () => {
          expect(restored).toContain("Restore complete.");
          expect(restored).toMatch(
            new RegExp(`Server:\\s+${target.url} \\(initialized\\)`),
          );
          expect(await bootstrapState(target.url)).toBe("ready");
        },
      );
      await step(
        "The runner token from the backup reads the same value there",
        async () => {
          const result = await app
            .cliRaw(["run", "--", ...printVar("API_KEY")], {
              env: {
                HOME: target.root,
                DOPBASE_URL: target.url,
                DOPBASE_TOKEN: token,
                DOPBASE_DATA_DIR: await tempDir(app, "restored"),
              },
            })
            .stdout();
          expect(result).toBe(value);
        },
      );
    });
  },
);

test(
  "restore with the wrong key fails and changes nothing",
  {
    tag: "@backup",
    annotation: about(
      "Restoring with a master key that didn't make the backup fails, and the target server stays uninitialized; a missing file or a non-.dop file is refused first.",
    ),
  },
  async () => {
    test.setTimeout(60_000);
    const dir = await tempDir(app, "wrong");
    const path = join(dir, "snapshot.dop");
    await app.cli(["backup", app.uniq("wrong-key"), "--output", path]).ok();
    const wrongKey = randomBytes(32).toString("hex");
    await withUninitialized(async (target) => {
      const result = await step(
        "dopbase restore snapshot.dop --key <another key> --setup-token setup_… --yes",
        async () =>
          app
            .cli([
              "--server",
              target.url,
              "restore",
              path,
              "--key",
              wrongKey,
              "--setup-token",
              target.setupToken!,
              "--yes",
            ])
            .fails(1),
      );
      await step(
        "It fails with an error after the progress lines",
        async () => {
          expect(result.stderr).toMatch(/^Error: /m);
          expect(result.stderr).toContain("BACKUP_DECRYPT_FAILED");
        },
      );
      await step("The target still needs setup", async () => {
        expect(await bootstrapState(target.url)).toBe("setupRequired");
      });
    });
    const missing = await step("dopbase restore missing.dop --yes", async () =>
      app.cli(["restore", join(dir, "missing.dop"), "--yes"]).fails(1),
    );
    await step("A missing file is refused", async () => {
      expect(missing.stderr).toContain("Backup file not found");
    });
    const notDop = join(dir, "snapshot.zip");
    await writeFile(notDop, "not a backup");
    const wrongType = await step(
      "dopbase restore snapshot.zip --yes",
      async () => app.cli(["restore", notDop, "--yes"]).fails(1),
    );
    await step("A file without .dop is refused", async () => {
      expect(wrongType.stderr).toContain("must have a .dop extension");
    });
  },
);
