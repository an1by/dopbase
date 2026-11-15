import { printVar, tempDir, tokenEnv } from "../harness/helpers.ts";
import { about, expect, step, test, useServer } from "../harness/index.ts";
import { confirmPasswordWhenAsked } from "../ui/support.ts";

const app = useServer();

test(
  "a CI pipeline reads secrets with a runner token until it is revoked",
  {
    tag: "@tokens",
    annotation: about(
      "A runner token made in the Admin UI lets `dopbase run` read its environment, and revoking it in the UI stops the next run.",
    ),
  },
  async ({ page }) => {
    const project = await app.make.project(app.uniq("billing"));
    const prod = await app.make.environment({ project, name: "prod" });
    const apiKey = await app.make.secret(prod, "API_KEY");
    const tokenName = app.uniq("deploy");
    let token = "";

    await step("Root opens the prod Tokens tab in the Admin UI", async () => {
      await app.signIn(page);
      await confirmPasswordWhenAsked(page);
      await page.goto(`/projects/${project.name}/prod/tokens`);
      await expect(
        page.getByRole("heading", { name: "No runner tokens yet" }),
      ).toBeVisible();
    });

    await step(`Root creates the runner token ${tokenName}`, async () => {
      await page.getByRole("button", { name: "New runner token" }).click();
      const dialog = page.getByRole("dialog", { name: "New runner token" });
      await dialog.getByLabel("Name").fill(tokenName);
      const copy = page.getByRole("dialog", { name: "Copy your token" });
      await dialog.getByRole("button", { name: "Create token" }).click();
      await expect(copy).toBeVisible();
      token = await copy.getByLabel("Generated token").inputValue();
      expect(token).not.toBe("");
      await copy.getByRole("button", { name: "I've stored it" }).click();
      await expect(page.getByTestId("token-row")).toContainText(tokenName);
    });

    const runner = await tempDir(app, "ci");

    await step(
      "The pipeline runs `dopbase run -- printenv API_KEY` with DOPBASE_TOKEN",
      async () => {
        const out = await app
          .cliRaw(["run", "--", ...printVar("API_KEY")], {
            env: tokenEnv(app, token, runner),
          })
          .stdout();
        expect(out).toBe(apiKey);
      },
    );

    await step("The token can't read another environment", async () => {
      const dev = await app.make.environment({ project, name: "dev" });
      await app.make.secret(dev, "API_KEY");
      const run = await app
        .cliRaw(["run", dev.ref, "--", ...printVar("API_KEY")], {
          env: tokenEnv(app, token, runner),
        })
        .fails();
      expect(run.stderr).toContain(`cannot access ${dev.ref}`);
    });

    await step("Root revokes the token in the Admin UI", async () => {
      await page.reload();
      await page
        .getByRole("button", { name: `Actions for ${tokenName}` })
        .click();
      await page.getByRole("menuitem", { name: "Revoke token" }).click();
      const confirm = page.getByRole("dialog", {
        name: "Revoke runner token",
      });
      await confirm
        .getByLabel(`Type "${tokenName}" to confirm`)
        .fill(tokenName);
      await confirm.getByRole("button", { name: "Revoke token" }).click();
      await expect(confirm).toBeHidden();
      await expect(
        page.getByRole("button", { name: `Actions for ${tokenName}` }),
      ).toBeVisible();
    });

    await step(
      "The next pipeline run is refused, even on the runner that cached the secrets",
      async () => {
        const run = await app
          .cliRaw(["run", "--", ...printVar("API_KEY")], {
            env: tokenEnv(app, token, runner),
          })
          .fails();
        expect(run.stdout).not.toContain(apiKey);
        expect(run.stderr).toContain("authentication failed");
      },
    );

    await step("The API refuses the revoked token too", async () => {
      const api = await app.apiWithToken(token);
      const res = await api.get(`/environments/${prod.id}/secrets`);
      expect(res.status).toBe(401);
      await api.dispose();
    });
  },
);
