import { about, expect, step, test, useServer } from "../harness/index.ts";
import {
  chooseAction,
  confirmPasswordWhenAsked,
  dialog,
  giveAccess,
} from "./support.ts";

// Giving people access needs people management on.
const app = useServer({ env: { DOPBASE_RBAC: "true" } });

test(
  "add and remove access on a project",
  {
    tag: "@access",
    annotation: about(
      "From a project's Access tab, Give access grants a person Write on the whole project, and Remove access takes it away again.",
    ),
  },
  async ({ page }) => {
    const env = await app.make.environment({ name: "dev" });
    const person = await app.make.user();
    const project = env.projectName;
    await app.signIn(page);
    await confirmPasswordWhenAsked(page);

    await step("Open the project's Access tab", async () => {
      await page.goto(`/projects/${project}/dev/secrets`);
      await page.getByRole("link", { name: "Access", exact: true }).click();
      await expect(page).toHaveURL(`/projects/${project}/access`);
      await expect(
        page.getByRole("heading", { name: "No one has been given access yet" }),
      ).toBeVisible();
    });
    await step("Click Give access", async () => {
      await page.getByRole("button", { name: "Give access" }).click();
      await expect(page).toHaveURL(`/projects/${project}/access/new`);
    });
    await step(`Give ${person.email} Write on the whole project`, async () => {
      await giveAccess(page, { who: person.email, level: "Write" });
    });
    await step(`${person.email} is listed with Write`, async () => {
      await expect(page).toHaveURL(`/projects/${project}/access`);
      await expect(
        page.getByRole("row", {
          name: new RegExp(`^${person.email}.*Whole project.*Write`),
        }),
      ).toBeVisible();
    });
    await step(`Choose Remove access on ${person.email}`, async () => {
      await chooseAction(page, `Actions for ${person.email}`, "Remove access");
      const remove = dialog(page, "Remove access");
      await remove.getByRole("button", { name: "Remove access" }).click();
      await expect(remove).toBeHidden();
    });
    await step("Nobody has access again", async () => {
      await expect(
        page.getByRole("heading", { name: "No one has been given access yet" }),
      ).toBeVisible();
    });
  },
);
