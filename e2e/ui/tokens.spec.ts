import { about, expect, step, test, useServer } from "../harness/index.ts";
import {
  chooseAction,
  confirmPasswordWhenAsked,
  dialog,
  typeToConfirm,
} from "./support.ts";

const app = useServer();

test(
  "create a runner token, see its value once, then revoke it",
  {
    tag: "@tokens",
    annotation: about(
      "New runner token shows the token one time; it reads the environment until Revoke, after which it is refused and listed as Revoked.",
    ),
  },
  async ({ page }) => {
    const env = await app.make.environment();
    const name = app.uniq("deploy");
    await app.signIn(page);
    await confirmPasswordWhenAsked(page);

    await step("Open dev tokens", async () => {
      await page.goto(`/projects/${env.projectName}/${env.name}/tokens`);
      await expect(
        page.getByRole("heading", { name: "No runner tokens yet" }),
      ).toBeVisible();
    });
    await step(`Click New runner token and create ${name}`, async () => {
      await page.getByRole("button", { name: "New runner token" }).click();
      const create = dialog(page, "New runner token");
      await create.getByLabel("Name").fill(name);
      await create.getByRole("button", { name: "Create token" }).click();
    });
    const shown = dialog(page, "Copy your token");
    let token = "";
    await step("The token is shown once", async () => {
      await expect(
        shown.getByText("You won't see this token again"),
      ).toBeVisible();
      const field = shown.getByLabel("Generated token");
      await expect(field).not.toHaveValue("");
      token = await field.inputValue();
    });
    await step("Click I've stored it", async () => {
      await shown.getByRole("button", { name: "I've stored it" }).click();
      await expect(shown).toBeHidden();
    });
    await step(`${name} is listed and the value is gone`, async () => {
      await expect(
        page.getByRole("row", { name: new RegExp(`^${name} `) }),
      ).toBeVisible();
      await expect(page.getByText(token)).toHaveCount(0);
    });
    await step("The token reads the environment", async () => {
      const runner = await app.apiWithToken(token);
      const read = await runner.send("GET", "/runtime/secrets", undefined, {
        record: false,
      });
      expect(read.status).toBe(200);
      await runner.dispose();
    });
    await step(`Choose Revoke token on ${name} and confirm`, async () => {
      await chooseAction(page, `Actions for ${name}`, "Revoke token");
      await typeToConfirm(
        dialog(page, "Revoke runner token"),
        name,
        "Revoke token",
      );
    });
    await step(`${name} is listed as Revoked`, async () => {
      await expect(
        page.getByRole("row", { name: new RegExp(`^${name} .*Revoked`) }),
      ).toBeVisible();
    });
    await step("The token is refused now", async () => {
      const runner = await app.apiWithToken(token);
      const read = await runner.send("GET", "/runtime/secrets", undefined, {
        record: false,
      });
      expect(read.status).toBe(401);
      await runner.dispose();
    });
  },
);
