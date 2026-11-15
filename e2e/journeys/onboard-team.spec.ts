import { randomBytes } from "node:crypto";
import { printVar, tempDir, tokenEnv } from "../harness/helpers.ts";
import {
  about,
  expect,
  step,
  stepOn,
  test,
  useServer,
  type Environment,
} from "../harness/index.ts";
import { confirmPasswordWhenAsked } from "../ui/support.ts";

// Adding people and giving them access needs RBAC on.
const app = useServer({ env: { DOPBASE_RBAC: "true" } });

test(
  "root brings a teammate from nothing to running an app on development",
  {
    tag: "@access",
    annotation: about(
      "A project and a teammate made in the Admin UI, with read on development only, give that teammate exactly one environment: they can see and run it from the UI and the CLI, but can't change it or reach production.",
    ),
  },
  async ({ newContext, page }) => {
    const project = app.uniq("billing");
    const email = `${app.uniq("maya")}@dopbase.com`;
    const password = `pw-${randomBytes(12).toString("hex")}`;
    const member = { email, password };
    const envs: Record<string, Environment> = {};
    let apiKey = "";

    await step(`Root creates project ${project} in the Admin UI`, async () => {
      await app.signIn(page);
      await confirmPasswordWhenAsked(page);
      await page.goto("/projects");
      await page.getByTestId("new-project").click();
      const dialog = page.getByRole("dialog", { name: "New project" });
      await dialog.getByLabel("Project name").fill(project);
      await dialog.getByRole("button", { name: "Create" }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${project}$`));
      // The project page reuses the project list from before the create
      // for a few seconds; see the fixme test below. A reload gets past it.
      await page.reload();
      await expect(
        page.getByRole("heading", { name: `Set up ${project}` }),
      ).toBeVisible();
    });

    await step(
      "Root creates development, staging and a protected production",
      async () => {
        await page
          .getByRole("button", { name: "Create 3 environments" })
          .click();
        await expect(page).toHaveURL(
          new RegExp(`/projects/${project}/development/secrets$`),
        );
        const listed: Omit<Environment, "ref">[] = await app.api.must(
          "GET",
          `/environments?project=${project}`,
          undefined,
          { record: false },
        );
        for (const env of listed)
          envs[env.name] = { ...env, ref: `${project}/${env.name}` };
        expect(Object.keys(envs).sort()).toEqual([
          "development",
          "production",
          "staging",
        ]);
        expect(envs.production!.protected).toBe(true);
        apiKey = await app.make.secret(envs.development!, "API_KEY");
        await app.make.secret(envs.production!, "API_KEY");
      },
    );

    await step(`Root adds ${email} as a Member on the Users page`, async () => {
      await page.goto("/users");
      await page.getByTestId("add-user").click();
      const dialog = page.getByRole("dialog", { name: "Add user" });
      await dialog.getByLabel("Email").fill(email);
      await dialog.getByLabel("Temporary password").fill(password);
      await expect(
        dialog.getByRole("radio", { name: /^Member/ }),
      ).toBeChecked();
      await dialog.getByRole("button", { name: "Add user" }).click();
      await expect(dialog).toBeHidden();
      // A new person opens on their Access tab, with nothing there yet.
      await expect(page.getByRole("heading", { name: email })).toBeVisible();
      await expect(
        page.getByText(`${email} doesn't reach any project yet.`),
      ).toBeVisible();
    });

    await step(
      "Root gives them Read on development only, from the project's Access tab",
      async () => {
        await page.goto(`/projects/${project}/access`);
        await page.getByTestId("give-access").click();
        await expect(
          page.getByRole("heading", { name: "Give access" }),
        ).toBeVisible();
        await page.getByTestId("principal-picker").click();
        await page
          .getByTestId("principal-choice")
          .filter({ hasText: email })
          .click();
        await page
          .getByRole("radiogroup", { name: "Where" })
          .getByText("Some environments", { exact: true })
          .click();
        const choices = page.getByTestId("environment-choices");
        await choices.getByText("development", { exact: true }).click();
        await page
          .getByRole("radiogroup", { name: "Level" })
          .getByText("Read", { exact: true })
          .click();
        const review = page.getByTestId("give-access-review");
        await expect(review.getByTestId("planned-grant")).toHaveCount(1);
        await expect(review.getByTestId("planned-grant")).toContainText(
          `${project} / development`,
        );
        await page.getByTestId("give-access-submit").click();
        await expect(page.getByTestId("access-grants")).toBeVisible();
        await expect(page.getByTestId("access-grants")).toContainText(email);
      },
    );

    const memberContext = await newContext("teammate");
    const memberPage = await memberContext.newPage();
    try {
      await stepOn(
        memberPage,
        "The teammate signs in with their password",
        async () => {
          await memberPage.goto(`${app.url}/login`);
          await memberPage.getByLabel("Email").fill(email);
          await memberPage
            .getByLabel("Password", { exact: true })
            .fill(password);
          await memberPage.getByRole("button", { name: "Sign in" }).click();
          await expect(memberPage).toHaveURL(/\/projects/);
        },
      );

      await stepOn(
        memberPage,
        "They see the project with development only",
        async () => {
          await memberPage.goto(`${app.url}/projects`);
          const tree = memberPage.getByTestId("project-tree");
          await expect(tree).toContainText(project);
          const open = memberPage.getByRole("link", {
            name: /^Open secrets in /,
          });
          // The first project opens as soon as projects load, before its
          // environments arrive, so go by the row's state, not the links.
          const row = tree.locator("button[aria-expanded]", {
            has: memberPage.getByText(project, { exact: true }),
          });
          if ((await row.getAttribute("aria-expanded")) !== "true")
            await row.click();
          await expect(open).toHaveCount(1);
          await expect(open).toHaveAccessibleName(/development/);
          await expect(tree).not.toContainText("staging");
          await expect(tree).not.toContainText("production");
        },
      );

      await stepOn(
        memberPage,
        "Development opens with API_KEY listed",
        async () => {
          await memberPage.goto(
            `${app.url}/projects/${project}/development/secrets`,
          );
          await expect(memberPage.getByTestId("secrets-table")).toContainText(
            "API_KEY",
          );
          await expect(memberPage.getByTestId("secrets-add")).toHaveCount(0);
        },
      );

      await stepOn(memberPage, "Production isn't there for them", async () => {
        await memberPage.goto(
          `${app.url}/projects/${project}/production/secrets`,
        );
        await expect(
          memberPage.getByTestId("environment-missing"),
        ).toBeVisible();
      });
    } finally {
      await memberContext.close();
    }

    let token = "";
    await step(
      "The teammate makes a personal token with `dopbase token personal create`",
      async () => {
        const created = await app
          .cli(
            [
              "--json",
              "token",
              "personal",
              "create",
              "--name",
              "laptop",
              "--env",
              envs.development!.ref,
              "--expires-in",
              "12h",
            ],
            { as: member },
          )
          .json();
        token = created.plaintextToken;
        expect(token).toMatch(/^dpp_/);
      },
    );

    const laptop = await tempDir(app, "laptop");

    await step(
      "Their app runs with `dopbase run billing/development` and gets API_KEY",
      async () => {
        const out = await app
          .cliRaw(
            ["run", envs.development!.ref, "--", ...printVar("API_KEY")],
            { env: tokenEnv(app, token, laptop) },
          )
          .stdout();
        expect(out).toBe(apiKey);
      },
    );

    await step(
      "`dopbase access` shows read on development and nothing else",
      async () => {
        const out = await app.cli(["access"], { as: member }).stdout();
        expect(out).toMatch(
          new RegExp(`^${project}/development\\s+read\\s+direct$`, "m"),
        );
        expect(out).toContain("1 grant(s)");
        expect(out).not.toContain("production");
        expect(out).not.toContain("staging");
      },
    );

    await step(
      "They can't change a secret, signed in or with the token",
      async () => {
        const value = app.value();
        const signedIn = await app
          .cli(["secret", "set", envs.development!.ref, "API_KEY", "--stdin"], {
            as: member,
            stdin: value,
          })
          .fails();
        expect(signedIn.stderr).toContain("AUTHORIZATION_DENIED");
        const withToken = await app
          .cliRaw(
            ["secret", "set", envs.development!.ref, "API_KEY", "--stdin"],
            { env: tokenEnv(app, token, laptop), stdin: value },
          )
          .fails();
        expect(withToken.stderr).toContain("AUTHORIZATION_DENIED");
        const current = await app.api.must(
          "GET",
          `/environments/${envs.development!.id}/secrets/API_KEY`,
          undefined,
          { record: false },
        );
        expect(current.version).toBe(1);
      },
    );

    await step(
      "They can't run production, signed in or with the token",
      async () => {
        const signedIn = await app
          .cli(["run", envs.production!.ref, "--", ...printVar("API_KEY")], {
            as: member,
          })
          .fails();
        expect(signedIn.stderr).toContain("ENVIRONMENT_NOT_FOUND");
        const run = await app
          .cliRaw(["run", envs.production!.ref, "--", ...printVar("API_KEY")], {
            env: tokenEnv(app, token, laptop),
          })
          .fails();
        expect(run.stdout).toBe("");
        expect(run.stderr).toContain("ENVIRONMENT_NOT_FOUND");
      },
    );

    await step("The API refuses the token on production too", async () => {
      const api = await app.apiWithToken(token);
      const res = await api.get(`/environments/${envs.production!.id}/secrets`);
      expect([403, 404]).toContain(res.status);
      await api.dispose();
    });
  },
);

test(
  "a project made on Projects opens on its setup checklist",
  {
    tag: "@projects",
    annotation: about(
      "Creating a project from the Projects page refreshes the cached project list before the project opens, so its page shows 'Set up <project>' straight away, not 'No environments yet'.",
    ),
  },
  async ({ page }) => {
    const project = app.uniq("billing");
    await step("Root creates a project on the Projects page", async () => {
      await app.signIn(page);
      await page.goto("/projects");
      await page.getByTestId("new-project").click();
      const dialog = page.getByRole("dialog", { name: "New project" });
      await dialog.getByLabel("Project name").fill(project);
      await dialog.getByRole("button", { name: "Create" }).click();
    });
    await step("Its setup checklist opens straight away", async () => {
      await expect(
        page.getByRole("heading", { name: `Set up ${project}` }),
      ).toBeVisible();
    });
  },
);
