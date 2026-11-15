import {
  about,
  expect,
  step,
  test,
  useServer,
  type Environment,
} from "../harness/index.ts";
import {
  chooseAction,
  confirmPasswordWhenAsked,
  dialog,
  typeToConfirm,
} from "./support.ts";
import type { Page } from "@playwright/test";
import { auditEvents } from "../api/support.ts";

const app = useServer();

const secretsUrl = (env: Environment) =>
  `/projects/${env.projectName}/${env.name}/secrets`;

/** The revealed value row under a secret, once Reveal was clicked. */
async function expectRevealed(page: Page, value: string): Promise<void> {
  await expect(page.getByText(value, { exact: true })).toBeVisible();
}

test(
  "add, edit, reveal and delete a secret",
  {
    tag: "@secrets",
    annotation: about(
      "A new secret is saved as v1, editing stores v2, Reveal shows the current value, and Delete removes the key after it is typed.",
    ),
  },
  async ({ page }) => {
    const env = await app.make.environment();
    // A secret already there, so the table and its toolbar are shown.
    await app.make.secret(env, "EXISTING_KEY");
    const first = app.value();
    const second = app.value();
    await app.signIn(page);
    await confirmPasswordWhenAsked(page);

    await step("Open dev secrets", async () => {
      await page.goto(secretsUrl(env));
      await expect(page.getByText("EXISTING_KEY")).toBeVisible();
    });
    await step("Click Add secret and save DATABASE_URL", async () => {
      await page.getByRole("button", { name: "Add secret" }).click();
      const add = dialog(page, "Add secret");
      await add.getByLabel("Key").fill("DATABASE_URL");
      await add.getByRole("textbox", { name: "Value" }).fill(first);
      await add.getByRole("button", { name: "Save secret" }).click();
      await expect(add).toBeHidden();
    });
    await step("DATABASE_URL is listed as v1", async () => {
      await expect(
        page.getByRole("row", { name: /^DATABASE_URL .* v1 / }),
      ).toBeVisible();
    });
    await step("Click Reveal on DATABASE_URL", async () => {
      await page.getByRole("button", { name: "Reveal DATABASE_URL" }).click();
    });
    await step("The value is shown", async () => {
      await expectRevealed(page, first);
    });
    await step("Choose Edit value and save a new value", async () => {
      await chooseAction(page, "Actions for DATABASE_URL", "Edit value");
      const edit = dialog(page, "Update secret");
      await expect(
        edit.getByText("Saving stores the new value as v2"),
      ).toBeVisible();
      await edit.getByRole("textbox", { name: "Value" }).fill(second);
      await edit.getByRole("button", { name: "Save new version" }).click();
      await expect(edit).toBeHidden();
    });
    await step("DATABASE_URL is now v2", async () => {
      await expect(
        page.getByRole("row", { name: /^DATABASE_URL .* v2 / }),
      ).toBeVisible();
    });
    await step("Reveal shows the new value", async () => {
      const reveal = page.getByRole("button", { name: "Reveal DATABASE_URL" });
      if (await reveal.isVisible()) await reveal.click();
      await expectRevealed(page, second);
    });
    await step("Choose Delete and type DATABASE_URL to confirm", async () => {
      await chooseAction(page, "Actions for DATABASE_URL", "Delete");
      await typeToConfirm(
        dialog(page, "Delete secret"),
        "DATABASE_URL",
        "Delete secret",
      );
    });
    await step("DATABASE_URL is gone, EXISTING_KEY stays", async () => {
      await expect(page.getByText("DATABASE_URL")).toHaveCount(0);
      await expect(page.getByText("EXISTING_KEY")).toBeVisible();
    });
  },
);

test(
  "Copy value copies without showing the value",
  {
    tag: "@secrets",
    annotation: about(
      "Copy value in a secret's row menu puts the value on the clipboard after the password check, never shows it on the page, and is audited like a reveal.",
    ),
  },
  async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const env = await app.make.environment({ name: "dev" });
    const value = await app.make.secret(env, "API_KEY");
    await confirmPasswordWhenAsked(page);
    await app.signIn(page);
    await step("Open the environment's secrets", async () => {
      await page.goto(secretsUrl(env));
      await expect(
        page.getByRole("button", { name: "Actions for API_KEY" }),
      ).toBeVisible();
    });
    await step("Choose Copy value for API_KEY", async () => {
      await chooseAction(page, "Actions for API_KEY", "Copy value");
    });
    await step("The clipboard holds the value", async () => {
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(value);
    });
    await step("The value is nowhere on the page", async () => {
      await expect(page.getByText(value)).toHaveCount(0);
    });
    await step("The copy is audited as a reveal", async () => {
      const events = await auditEvents(app, {
        action: "secret.revealed",
        environment: env.id,
      });
      expect(events.length).toBeGreaterThan(0);
    });
  },
);

test(
  "history shows every version and rollback saves the old value as new",
  {
    tag: "@secrets",
    annotation: about(
      "With two versions saved, History lists both and rolling back to v1 stores its value as v3.",
    ),
  },
  async ({ page }) => {
    const env = await app.make.environment();
    const old = await app.make.secret(env, "API_KEY");
    await app.make.secret(env, "API_KEY");
    await app.signIn(page);
    await confirmPasswordWhenAsked(page);

    await step("Open dev secrets", async () => {
      await page.goto(secretsUrl(env));
      await expect(
        page.getByRole("row", { name: /^API_KEY .* v2 / }),
      ).toBeVisible();
    });
    const history = dialog(page, "Secrets history");
    await step("Choose History on API_KEY", async () => {
      await chooseAction(page, "Actions for API_KEY", "History");
    });
    await step("Both versions are listed, v2 is current", async () => {
      await expect(history.getByText("Current version v2.")).toBeVisible();
      await expect(
        history.getByRole("row", { name: /^v2 current/ }),
      ).toBeVisible();
      await expect(history.getByRole("row", { name: /^v1 / })).toBeVisible();
    });
    await step("Click Reveal v1", async () => {
      await history.getByRole("button", { name: "Reveal v1" }).click();
      await expect(history.getByText(old)).toBeVisible();
    });
    await step("Click Roll back to v1 and confirm", async () => {
      await history.getByRole("button", { name: "Roll back to v1" }).click();
      const confirm = history.getByTestId("rollback-confirm");
      await expect(
        confirm.getByText("Save the value from v1 as a new version, v3?"),
      ).toBeVisible();
      await confirm.getByRole("button", { name: "Roll back to v1" }).click();
    });
    await step("v3 is current", async () => {
      await expect(history.getByText("Current version v3.")).toBeVisible();
      await expect(
        history.getByRole("row", { name: /^v3 current/ }),
      ).toBeVisible();
    });
    await step("Close history and reveal API_KEY", async () => {
      await history.getByRole("button", { name: "Close dialog" }).click();
      await expect(
        page.getByRole("row", { name: /^API_KEY .* v3 / }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Reveal API_KEY" }).click();
    });
    await step("The value is v1's again", async () => {
      await expectRevealed(page, old);
    });
  },
);

test(
  "import a .env file through the review page",
  {
    tag: "@secrets",
    annotation: about(
      "Import parses a .env file in the browser, the review page lists its keys without values, Validate shows what changes, and Apply stores them.",
    ),
  },
  async ({ page }) => {
    const env = await app.make.environment();
    await app.make.secret(env, "EXISTING_KEY");
    const dotenv = [
      "# from the old host",
      `IMPORTED_ONE=${app.value()}`,
      `IMPORTED_TWO="${app.value()}"`,
      "",
    ].join("\n");
    await app.signIn(page);
    await confirmPasswordWhenAsked(page);

    await step("Open dev secrets", async () => {
      await page.goto(secretsUrl(env));
      await expect(page.getByText("EXISTING_KEY")).toBeVisible();
    });
    await step("Click Import and choose a .env file", async () => {
      await page.getByRole("button", { name: "Import", exact: true }).click();
      const chooser = page.waitForEvent("filechooser");
      await dialog(page, "Import .env secrets")
        .getByText("Choose a file")
        .click();
      await (
        await chooser
      ).setFiles({
        name: ".env",
        mimeType: "text/plain",
        buffer: Buffer.from(dotenv),
      });
    });
    await step("The review page lists both keys", async () => {
      await expect(page).toHaveURL(
        `/projects/${env.projectName}/${env.name}/import`,
      );
      await expect(
        page.getByRole("heading", { name: "Review import" }),
      ).toBeVisible();
      await expect(page.getByText("Keys (2)")).toBeVisible();
      await expect(page.getByText("IMPORTED_ONE")).toBeVisible();
      await expect(page.getByText("IMPORTED_TWO")).toBeVisible();
    });
    await step("Click Validate", async () => {
      await page.getByRole("button", { name: "Validate" }).click();
    });
    await step("Both keys would be added", async () => {
      await expect(page.getByText("Validate changes ok")).toBeVisible();
      await expect(page.getByText("added (2)")).toBeVisible();
    });
    await step("Click Apply import", async () => {
      await page.getByRole("button", { name: "Apply import" }).click();
    });
    await step("Secrets lists the imported keys", async () => {
      await expect(page).toHaveURL(
        new RegExp(`${secretsUrl(env)}(\\?imported=\\d+)?$`),
      );
      await expect(
        page.getByRole("row", { name: /^IMPORTED_ONE / }),
      ).toBeVisible();
      await expect(
        page.getByRole("row", { name: /^IMPORTED_TWO / }),
      ).toBeVisible();
      await expect(
        page.getByRole("row", { name: /^EXISTING_KEY / }),
      ).toBeVisible();
    });
  },
);

test(
  "compare two environments and copy a secret across",
  {
    tag: "@secrets",
    annotation: about(
      "Compare marks a key that prod lacks; Set with Match dev copies dev's value on the server, and prod then reveals the same value.",
    ),
  },
  async ({ page }) => {
    const dev = await app.make.environment({ name: "dev" });
    const prod = await app.make.environment({
      project: { id: dev.projectId, name: dev.projectName },
      name: "prod",
    });
    const value = await app.make.secret(dev, "API_KEY");
    await app.make.secret(prod, "SHARED_KEY");
    await app.make.secret(dev, "SHARED_KEY");
    await app.signIn(page);
    await confirmPasswordWhenAsked(page);

    await step("Open dev and click Compare", async () => {
      await page.goto(secretsUrl(dev));
      await page.getByRole("link", { name: "Compare" }).click();
      await expect(page).toHaveURL(`/projects/${dev.projectName}/dev/compare`);
    });
    await step("API_KEY is missing in prod", async () => {
      await expect(
        page.getByRole("heading", {
          name: "Compare dev with other environments",
        }),
      ).toBeVisible();
      await expect(page.getByText("1 missing in prod")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Set API_KEY in prod" }),
      ).toBeVisible();
    });
    await step("Click Set API_KEY in prod and match dev", async () => {
      await page.getByRole("button", { name: "Set API_KEY in prod" }).click();
      const fill = dialog(page, "Set API_KEY in prod");
      await fill.getByText("Match dev").click();
      await fill.getByRole("button", { name: "Save" }).click();
      await expect(fill).toBeHidden();
    });
    await step("Nothing is missing in prod any more", async () => {
      await expect(page.getByText("0 missing in prod")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Set API_KEY in prod" }),
      ).toHaveCount(0);
    });
    await step("Open prod secrets and reveal API_KEY", async () => {
      await page.goto(secretsUrl(prod));
      await page.getByRole("button", { name: "Reveal API_KEY" }).click();
    });
    await step("prod has dev's value", async () => {
      await expectRevealed(page, value);
    });
  },
);
