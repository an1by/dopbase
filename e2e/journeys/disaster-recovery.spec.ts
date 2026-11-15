import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { printVar } from "../harness/helpers.ts";
import {
  about,
  expect,
  ROOT,
  ROOT_EMAIL,
  ROOT_PASSWORD,
  step,
  test,
  useServer,
} from "../harness/index.ts";
import { mintLaunchLink } from "../harness/server.ts";
import { pty } from "../harness/terminal.ts";
import { confirmPasswordWhenAsked } from "../ui/support.ts";
import { LocalServer } from "./support.ts";

// The file's own server only lends its temp dir and helpers: factory reset
// needs a server this test can stop without losing its files.
const app = useServer();

test(
  "root backs up in the UI, wipes the server with the CLI and restores it",
  {
    tag: "@backup",
    annotation: about(
      "A backup and master key downloaded from the Backups page are enough to bring a factory-reset server back: after `dopbase restore`, root signs in with the old password, the secrets and runner token work again, and `dopbase audit verify` passes.",
    ),
  },
  async ({ page }) => {
    const server = new LocalServer(join(app.server.root, "instance"));
    const downloads = join(app.server.root, "downloads");
    const backupFile = join(downloads, "before-reset.dop");
    const keyFile = join(downloads, "master.key");
    const project = app.uniq("billing");
    const apiKey = app.value();
    const dbUrl = app.value();
    let runnerToken = "";

    try {
      await step("A fresh server is set up with root", async () => {
        await server.start();
        const claim = await fetch(`${server.url}/api/v1/bootstrap/admin`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            setupToken: server.setupToken,
            email: ROOT_EMAIL,
            password: ROOT_PASSWORD,
          }),
        });
        expect(claim.status).toBe(201);
      });

      await step(
        `Root seeds ${project}/prod with two secrets and a runner token`,
        async () => {
          const api = await server.apiAs(ROOT);
          await api.must("POST", "/projects", { name: project });
          const env = await api.must(
            "POST",
            `/projects/${project}/environments`,
            { name: "prod", protected: true },
          );
          for (const [key, value] of [
            ["API_KEY", apiKey],
            ["DATABASE_URL", dbUrl],
          ] as const) {
            await api.must("PUT", `/environments/${env.id}/secrets/${key}`, {
              value,
            });
          }
          const token = await api.must(
            "POST",
            `/environments/${env.id}/tokens`,
            { name: "deploy", role: "runner", expiresIn: "30d" },
          );
          runnerToken = token.plaintextToken;
          app.secrets.add(runnerToken);
          await api.dispose();
        },
      );

      await step("Root creates a backup on the Backups page", async () => {
        await page.goto(`${server.url}${await mintLaunchLink(server.dataDir)}`);
        await expect(page).not.toHaveURL(/\/launch/);
        await confirmPasswordWhenAsked(page);
        await page.goto(`${server.url}/backups`);
        await page.getByTestId("create-backup").click();
        const dialog = page.getByRole("dialog", { name: "Create backup" });
        await dialog.getByLabel("Name (optional)").fill("before-reset");
        const row = page
          .getByTestId("backup-row")
          .filter({ hasText: "before-reset" });
        await dialog.getByRole("button", { name: "Create backup" }).click();
        await expect(row).toBeVisible();
      });

      await step(
        "Root downloads the backup and the master key from the UI",
        async () => {
          const row = page
            .getByTestId("backup-row")
            .filter({ hasText: "before-reset" });
          await row.getByRole("button", { name: /^Actions for / }).click();
          const backup = page.waitForEvent("download");
          await page.getByRole("menuitem", { name: "Download" }).click();
          await (await backup).saveAs(backupFile);

          const key = page.waitForEvent("download");
          await page
            .getByRole("button", { name: "Download master key" })
            .click();
          await expect(page.getByText("Master key downloaded.")).toBeVisible();
          await (await key).saveAs(keyFile);
          expect(existsSync(backupFile)).toBe(true);
          expect(existsSync(keyFile)).toBe(true);
        },
      );

      await step("The server is stopped for maintenance", async () => {
        await server.stop();
        const health = await fetch(`${server.url}/api/v1/health`).catch(
          () => null,
        );
        expect(health).toBeNull();
      });

      await step(
        "Root wipes it with `dopbase admin factory-reset`",
        async () => {
          const reset = await pty(
            ["--data-dir", server.dataDir, "admin", "factory-reset"],
            {
              env: { HOME: server.root },
              steps: [
                {
                  wait: "Type please-wipe-out-system to continue:",
                  send: "please-wipe-out-system\r",
                },
                {
                  wait: "Root password for root@dopbase.com:",
                  send: `${ROOT_PASSWORD}\r`,
                },
              ],
            },
          );
          expect(reset.code, reset.output).toBe(0);
          expect(reset.output).toContain("Factory reset complete.");
          expect(existsSync(server.dataDir)).toBe(false);
          expect(
            (await readdir(server.root)).some((name) =>
              /^data\.factory-reset-.*\.zip$/.test(name),
            ),
          ).toBe(true);
        },
      );

      await step(
        "The wiped server starts empty and asks for setup",
        async () => {
          await server.start();
          expect(server.setupToken).toMatch(/^setup_/);
          const status = await fetch(
            `${server.url}/api/v1/bootstrap/status`,
          ).then((res) => res.json());
          expect(status.data.state).toBe("setupRequired");
        },
      );

      await step(
        "Root restores the backup with `dopbase restore --key --setup-token`",
        async () => {
          await app
            .cliRaw(
              [
                "restore",
                backupFile,
                "--key",
                keyFile,
                "--setup-token",
                server.setupToken!,
                "--yes",
              ],
              { env: server.cliEnv() },
            )
            .ok();
        },
      );

      await step(
        "Root signs in to the Admin UI with the old password",
        async () => {
          await page.context().clearCookies();
          await page.goto(`${server.url}/login`);
          await page.getByLabel("Email").fill(ROOT_EMAIL);
          await page
            .getByLabel("Password", { exact: true })
            .fill(ROOT_PASSWORD);
          await page.getByRole("button", { name: "Sign in" }).click();
          await expect(page).toHaveURL(/\/projects$/);
          await expect(page.getByTestId("project-tree")).toContainText(project);
        },
      );

      await step("The secrets are listed in prod again", async () => {
        await page.goto(`${server.url}/projects/${project}/prod/secrets`);
        const table = page.getByTestId("secrets-table");
        await expect(table).toContainText("API_KEY");
        await expect(table).toContainText("DATABASE_URL");
      });

      await step(
        "The old runner token runs `dopbase run` and gets the old value",
        async () => {
          const out = await app
            .cliRaw(["run", "--", ...printVar("API_KEY")], {
              env: {
                ...server.cliEnv(join(server.root, "runner")),
                DOPBASE_TOKEN: runnerToken,
              },
            })
            .stdout();
          expect(out).toBe(apiKey);
        },
      );

      await step(
        "`dopbase audit verify` passes on the restored log",
        async () => {
          const env = await server.cliLogin(ROOT);
          const report = await app
            .cliRaw(["--json", "audit", "verify"], { env })
            .json();
          expect(report.ok).toBe(true);
          expect(report.broken ?? null).toBeNull();
          expect(report.records).toBeGreaterThan(0);
        },
      );

      await step("No secret value reached the server log", async () => {
        const log = await server.log();
        for (const value of [apiKey, dbUrl, runnerToken])
          expect(log).not.toContain(value);
      });
    } finally {
      await server.stop();
    }
  },
);
