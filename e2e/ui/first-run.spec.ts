import {
  ROOT_EMAIL,
  ROOT_PASSWORD,
  about,
  expect,
  step,
  test,
  useServer,
} from "../harness/index.ts";

// Root is left unclaimed so the browser can claim it.
const app = useServer({ claimRoot: false });

test(
  "first run claims root and lands on an empty Projects page",
  {
    tag: "@auth",
    annotation: about(
      "On a new server /setup takes the setup token, creates root, shows the recovery kit and then opens Projects with nothing in it.",
    ),
  },
  async ({ page }) => {
    await step("Open Projects on a server nobody has set up", async () => {
      await page.goto("/projects");
    });
    await step("Setup opens instead", async () => {
      await expect(page).toHaveURL(/\/setup$/);
      await expect(
        page.getByRole("heading", { name: "Create the root account" }),
      ).toBeVisible();
    });
    await step("Fill in the setup token, email and password", async () => {
      await page.getByLabel("Setup token").fill(app.server.setupToken!);
      await page.getByLabel("Root email").fill(ROOT_EMAIL);
      await page.getByLabel("Password", { exact: true }).fill(ROOT_PASSWORD);
      await page.getByLabel("Confirm password").fill(ROOT_PASSWORD);
    });
    await step("Click Continue", async () => {
      await page.getByRole("button", { name: "Continue" }).click();
    });
    await step("The recovery kit shows the master key", async () => {
      await expect(
        page.getByRole("heading", { name: "Save your recovery kit" }),
      ).toBeVisible();
      await expect(page.getByTestId("master-key")).toBeVisible();
    });
    await step("Tick that the recovery kit is stored", async () => {
      await page
        .getByText("I've stored the recovery kit outside this server")
        .click();
    });
    await step("Click Continue", async () => {
      await page.getByRole("button", { name: "Continue" }).click();
    });
    await step("Projects is empty, with setup's last step left", async () => {
      await expect(page).toHaveURL(/\/projects$/);
      await expect(
        page.getByRole("heading", { name: "Finish setting up Dopbase" }),
      ).toBeVisible();
      await expect(page.getByText("3 of 4 done")).toBeVisible();
      await expect(page.getByRole("list", { name: "Projects" })).toHaveCount(0);
    });
    await step("Setup is closed now that root exists", async () => {
      await page.goto("/setup");
      await expect(page).toHaveURL(/\/projects$/);
    });
  },
);
