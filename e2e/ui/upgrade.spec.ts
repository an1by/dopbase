// Restoring a 0.1.x backup from the setup page, the way someone moving to
// 0.2.0 does it in the browser (docs/self-hosting/upgrade-to-0-2.md). The
// API side of the upgrade is in api/upgrade.suite.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { about, expect, step, test, useServer } from "../harness/index.ts";

// Last 0.1.x release, so the one most people upgrade from.
const FIXTURE = join(import.meta.dirname, "../fixtures/upgrade/v0.1.10");
const seed = JSON.parse(readFileSync(join(FIXTURE, "seed.json"), "utf8"));
const [ada] = seed.people as { email: string; password: string }[];

// The server is left unclaimed so setup can restore onto it.
const app = useServer({ claimRoot: false, env: { DOPBASE_RBAC: "true" } });

test.beforeAll(() => {
  // The fixture's values count as seeded secrets for the leak check.
  for (const env of Object.values(seed.secrets) as Record<string, string>[]) {
    for (const value of Object.values(env)) app.secrets.add(value);
  }
  app.secrets.add(seed.deletedSecret.value);
});

test(
  "setup restores a 0.1.x backup from the browser",
  {
    tag: "@upgrade",
    annotation: about(
      `On a new 0.2.0 server, Restore a backup on the setup page takes the ${seed.version} backup and its master.key file, says the 0.1.x backup was upgraded, and a person from the backup signs in with their old password.`,
    ),
  },
  async ({ page }) => {
    await step("Open setup and choose Restore a backup", async () => {
      await page.goto("/setup");
      await page
        .getByRole("radiogroup", { name: "Setup mode" })
        .getByRole("radio", { name: "Restore a backup" })
        .click();
      await expect(
        page.getByRole("heading", { name: "Restore a backup" }),
      ).toBeVisible();
    });
    const form = page.getByTestId("restore-form");
    await step("Fill in the setup token", async () => {
      await form.getByLabel("Setup token").fill(app.server.setupToken!);
    });
    await step(`Choose the ${seed.version} backup`, async () => {
      const chooser = page.waitForEvent("filechooser");
      await form.getByRole("button", { name: /Choose a \.dop backup/ }).click();
      await (await chooser).setFiles(join(FIXTURE, "backup.dop"));
      await expect(form).toContainText("backup.dop");
    });
    await step("Use its master.key file", async () => {
      const chooser = page.waitForEvent("filechooser");
      await form.getByRole("button", { name: "Use a master.key file" }).click();
      await (await chooser).setFiles(join(FIXTURE, "master.key"));
      await expect(form).toContainText("master.key");
    });
    await step("Click Restore backup", async () => {
      await form.getByRole("button", { name: "Restore backup" }).click();
    });
    await step("Sign-in says the 0.1.x backup was upgraded", async () => {
      await expect(page).toHaveURL(/\/login/, { timeout: 60_000 });
      await expect(
        page.getByText(
          "Your Dopbase 0.1.x backup was upgraded and restored. Sign in with an account from the backup.",
        ),
      ).toBeVisible();
    });
    await step(
      `${ada.email} signs in with the ${seed.version} password`,
      async () => {
        await page.getByLabel("Email").fill(ada.email);
        await page.getByLabel("Password", { exact: true }).fill(ada.password);
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page).toHaveURL(/\/projects$/);
        await expect(
          page.getByRole("button", { name: "Account menu" }),
        ).toContainText(ada.email);
      },
    );
  },
);
