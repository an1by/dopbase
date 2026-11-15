import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { about, expect, step, test, useServer } from "../harness/index.ts";
import {
  confirmPasswordWhenAsked,
  dialog,
  openFromSidebar,
  typeToConfirm,
} from "./support.ts";

const app = useServer();

test(
  "create a backup, download the master key and restore",
  {
    tag: "@backup",
    annotation: about(
      "Backups downloads this server's master key, makes a named backup, and restoring it brings back the secrets as they were, dropping one added later.",
    ),
  },
  async ({ page }) => {
    const env = await app.make.environment({ name: "dev" });
    await app.make.secret(env, "BEFORE_BACKUP");
    const name = app.uniq("pre-upgrade");
    await app.signIn(page);
    await confirmPasswordWhenAsked(page);

    await step("Open Backups", async () => {
      await openFromSidebar(page, "Backups");
      await expect(page).toHaveURL(/\/backups$/);
      await expect(page.getByText("No backups yet")).toBeVisible();
    });
    await step("Click Download master key", async () => {
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download master key" }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe("master.key");
      const saved = await readFile(await file.path());
      const onDisk = await readFile(join(app.dataDir, "master.key"));
      expect(saved.equals(new Uint8Array(onDisk))).toBe(true);
    });
    await step("The download is confirmed", async () => {
      await expect(
        page.getByText(
          "Master key downloaded. Store it apart from your backups.",
        ),
      ).toBeVisible();
    });
    await step(`Click Create backup and name it ${name}`, async () => {
      await page.getByRole("button", { name: "Create backup" }).click();
      const create = dialog(page, "Create backup");
      await create.getByLabel("Name (optional)").fill(name);
      await create.getByRole("button", { name: "Create backup" }).click();
      await expect(create).toBeHidden();
    });
    const actions = page.getByRole("button", {
      name: new RegExp(`^Actions for .*${name}`),
    });
    await step(`${name} is listed`, async () => {
      await expect(actions).toBeVisible();
    });

    // A change after the backup, which the restore must undo.
    await app.make.secret(env, "AFTER_BACKUP");

    await step("Choose Restore and type RESTORE", async () => {
      await actions.click();
      await page.getByRole("menuitem", { name: "Restore" }).click();
      await typeToConfirm(
        dialog(page, "Restore this backup?"),
        "RESTORE",
        "Restore",
      );
    });
    await step("The restore is confirmed", async () => {
      await expect(
        page.getByText(/^System restored successfully from/),
      ).toBeVisible();
    });
    await step("dev has its secrets from before the backup", async () => {
      await page.goto(`/projects/${env.projectName}/dev/secrets`);
      await expect(
        page.getByRole("row", { name: /^BEFORE_BACKUP / }),
      ).toBeVisible();
      await expect(page.getByText("AFTER_BACKUP")).toHaveCount(0);
    });
  },
);
