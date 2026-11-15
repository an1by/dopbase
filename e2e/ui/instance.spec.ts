import { about, expect, step, test, useServer } from "../harness/index.ts";

const app = useServer();

test(
  "status checks run and show their results",
  {
    tag: "@admin",
    annotation: about(
      "The old /instance address opens Status, which flags a server with no backups as critical; after a backup, Run checks clears it and only suggests downloading the backup.",
    ),
  },
  async ({ page }) => {
    const env = await app.make.environment();
    await app.make.secret(env);
    await app.signIn(page);

    await step("Open /instance", async () => {
      await page.goto("/instance");
    });
    await step("Status opens and flags the missing backup", async () => {
      await expect(page).toHaveURL(/\/status$/);
      await expect(page.getByRole("heading", { name: "Status" })).toBeVisible();
      await expect(page.getByText("1 thing needs attention")).toBeVisible();
      await expect(
        page.getByText("No backups yet", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("Healthy")).toBeVisible();
    });

    // Fix what Status complained about, outside the page.
    await app.api.must("POST", "/backups", {}, { record: false });

    await step("Click Run checks", async () => {
      await page.getByRole("button", { name: "Run checks" }).click();
    });
    await step("The backup check passes, a download is suggested", async () => {
      await expect(
        page.getByText("No backups yet", { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText("The latest backup was never downloaded"),
      ).toBeVisible();
      await expect(
        page.getByText(/^1 warning\. \d+ other checks passed\. Checked/),
      ).toBeVisible();
    });
  },
);
