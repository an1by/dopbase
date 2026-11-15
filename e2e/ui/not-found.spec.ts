import { about, expect, step, test, useServer } from "../harness/index.ts";

const app = useServer();

test(
  "an unknown path shows not found",
  {
    tag: "@projects",
    annotation: about(
      "A URL that isn't a console page shows the 404 screen, and Back to projects leaves it.",
    ),
  },
  async ({ page }) => {
    await app.signIn(page);
    await step("Open /no-such-page", async () => {
      await page.goto(`/${app.uniq("no-such-page")}`);
    });
    await step("The not found screen is shown", async () => {
      await expect(page.getByText("404 · not found")).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "This route does not exist" }),
      ).toBeVisible();
    });
    await step("Click Back to projects", async () => {
      await page.getByRole("button", { name: "Back to projects" }).click();
      await expect(page).toHaveURL(/\/projects$/);
    });
  },
);

test(
  "legacy /projects/p/ URLs redirect to the new addresses",
  {
    tag: "@projects",
    annotation: about(
      "Links from before environments were named in the URL still work: project, access and environment-by-id addresses move to their new place.",
    ),
  },
  async ({ page }) => {
    const env = await app.make.environment({ name: "dev" });
    const project = env.projectName;
    await app.signIn(page);

    await step("Open the old project address", async () => {
      await page.goto(`/projects/p/${project}`);
    });
    await step("It opens the project's dev secrets", async () => {
      await expect(page).toHaveURL(`/projects/${project}/dev/secrets`);
    });
    await step("Open the old project access address", async () => {
      await page.goto(`/projects/p/${project}/access`);
    });
    await step("It opens the project's Access tab", async () => {
      await expect(page).toHaveURL(`/projects/${project}/access`);
    });
    await step("Open the old environment address by id", async () => {
      await page.goto(`/projects/p/${project}/e/${env.id}`);
    });
    await step("It opens dev by name", async () => {
      await expect(page).toHaveURL(`/projects/${project}/dev/secrets`);
    });
    await step("Open the old environment tokens address", async () => {
      await page.goto(`/projects/p/${project}/e/${env.id}/tokens`);
    });
    await step("It opens dev's Tokens tab", async () => {
      await expect(page).toHaveURL(`/projects/${project}/dev/tokens`);
    });
    await step("Open an environment address without a tab", async () => {
      await page.goto(`/projects/${project}/dev`);
    });
    await step("It opens the environment's secrets", async () => {
      await expect(page).toHaveURL(`/projects/${project}/dev/secrets`);
    });
  },
);
