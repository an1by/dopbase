import { about, expect, step, test, useServer } from "../harness/index.ts";
import { dialog, setCheckbox, typeToConfirm } from "./support.ts";

const app = useServer();

test(
  "create a project from Projects",
  {
    tag: "@projects",
    annotation: about(
      "New project on Projects creates the project and opens its page under the new name.",
    ),
  },
  async ({ page }) => {
    // Another project, so Projects shows its tree with the New project button.
    await app.make.project();
    const name = app.uniq("billing");
    await app.signIn(page);

    await step("Click New project", async () => {
      await page.getByRole("button", { name: "New project" }).click();
    });
    await step(`Name it ${name} and click Create`, async () => {
      const create = dialog(page, "New project");
      await create.getByLabel("Project name").fill(name);
      await create.getByRole("button", { name: "Create" }).click();
      await expect(create).toBeHidden();
    });
    await step("The new project's page opens", async () => {
      await expect(page).toHaveURL(`/projects/${name}`);
      await expect(
        page.getByRole("button", { name: `Project ${name}.` }),
      ).toBeVisible();
    });
  },
);

test(
  "a new project opens on its setup steps",
  {
    tag: "@projects",
    annotation: about(
      "New project on Projects opens the project on 'Set up <name>' at once: the project list is refreshed before the page opens, so the page already knows the project.",
    ),
  },
  async ({ page }) => {
    await app.make.project();
    const name = app.uniq("billing");
    await app.signIn(page);

    await step("Create a project from Projects", async () => {
      await page.getByRole("button", { name: "New project" }).click();
      const create = dialog(page, "New project");
      await create.getByLabel("Project name").fill(name);
      await create.getByRole("button", { name: "Create" }).click();
    });
    await step("Its setup steps are shown", async () => {
      await expect(
        page.getByRole("heading", { name: `Set up ${name}` }),
      ).toBeVisible();
    });
  },
);

test(
  "set up a new project's first environment",
  {
    tag: "@projects",
    annotation: about(
      "A project without environments offers development, staging and production; creating just development lands in it, ready for secrets.",
    ),
  },
  async ({ page }) => {
    const project = await app.make.project();
    await app.signIn(page);

    await step("Open the empty project", async () => {
      await page.goto(`/projects/${project.name}`);
    });
    await step("Its setup steps are shown", async () => {
      await expect(
        page.getByRole("heading", { name: `Set up ${project.name}` }),
      ).toBeVisible();
    });
    await step("Keep only development ticked", async () => {
      await setCheckbox(
        page.getByRole("checkbox", { name: "Create staging" }),
        false,
      );
      await setCheckbox(
        page.getByRole("checkbox", { name: "Create production" }),
        false,
      );
    });
    await step("Click Create 1 environment", async () => {
      await page.getByRole("button", { name: "Create 1 environment" }).click();
    });
    await step("development opens, ready for its first secret", async () => {
      await expect(page).toHaveURL(
        `/projects/${project.name}/development/secrets`,
      );
      await expect(
        page.getByRole("button", { name: "Environment development." }),
      ).toBeVisible();
    });
    await step("Projects lists it with one environment", async () => {
      await page.getByRole("link", { name: "Projects", exact: true }).click();
      await expect(
        page.getByRole("button", { name: `${project.name} 1 environment` }),
      ).toBeVisible();
    });
  },
);

test(
  "rename a project in settings",
  {
    tag: "@projects",
    annotation: about(
      "Save in Settings > General moves the page to the new name and the Settings tab comes back under it, with the project list and the switcher showing the new name.",
    ),
  },
  async ({ page }) => {
    const env = await app.make.environment({ name: "dev" });
    const renamed = app.uniq("renamed");
    await app.signIn(page);

    await step("Open the project's Settings", async () => {
      await page.goto(`/projects/${env.projectName}/settings`);
    });
    await step(`Change the name to ${renamed} and click Save`, async () => {
      await page.getByLabel("Name", { exact: true }).fill(renamed);
      await page.getByRole("button", { name: "Save", exact: true }).click();
    });
    await step("Settings shows the project under its new name", async () => {
      await expect(page).toHaveURL(`/projects/${renamed}/settings`);
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
        renamed,
      );
    });
    await step("Projects lists it under the new name", async () => {
      await page.getByRole("link", { name: "Projects", exact: true }).click();
      await expect(
        page.getByRole("button", { name: `${renamed} 1 environment` }),
      ).toBeVisible();
    });
  },
);

test(
  "the project page works at phone width",
  {
    tag: "@projects",
    annotation: about(
      "At 375 by 812 the project page's Secrets, Compare and Activity tabs open and the page never scrolls sideways.",
    ),
  },
  async ({ page }) => {
    const project = await app.make.project();
    const env = await app.make.environment({ project, name: "development" });
    await app.make.environment({ project, name: "staging" });
    await app.make.secret(env, "API_KEY");
    await page.setViewportSize({ width: 375, height: 812 });
    await app.signIn(page);
    const fitsTheScreen = async () => {
      const overflow = await page.evaluate(
        () =>
          document.scrollingElement!.scrollWidth -
          document.scrollingElement!.clientWidth,
      );
      expect(overflow, "pixels the page scrolls sideways").toBeLessThanOrEqual(
        0,
      );
    };

    await step("Open development's secrets", async () => {
      await page.goto(`/projects/${env.projectName}/development/secrets`);
      await expect(
        page.getByRole("button", { name: "Actions for API_KEY" }),
      ).toBeVisible();
      await fitsTheScreen();
    });
    for (const tab of ["Compare", "Activity", "Secrets"]) {
      await step(`Open the ${tab} tab`, async () => {
        await page
          .getByRole("navigation", { name: "Project sections" })
          .getByRole("link", { name: tab, exact: true })
          .click();
        await expect(page).toHaveURL(
          new RegExp(`/development/${tab.toLowerCase()}$`),
        );
        await fitsTheScreen();
      });
    }
  },
);

test(
  "delete a project from settings",
  {
    tag: "@projects",
    annotation: about(
      "Delete project in Settings asks for the name to be typed, then removes the project and returns to Projects.",
    ),
  },
  async ({ page }) => {
    const env = await app.make.environment({ name: "dev" });
    await app.make.secret(env, "API_KEY");
    const name = env.projectName;
    await app.signIn(page);

    await step("Open the project's Settings", async () => {
      await page.goto(`/projects/${name}/settings`);
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue(name);
    });
    await step("Click Delete project", async () => {
      await page.getByRole("button", { name: "Delete project" }).click();
    });
    await step(`Type ${name} and confirm`, async () => {
      await typeToConfirm(
        dialog(page, `Delete ${name}?`),
        name,
        "Delete project",
      );
    });
    await step("Projects no longer lists it", async () => {
      await expect(page).toHaveURL(/\/projects$/);
      await expect(page.getByText(name)).toHaveCount(0);
    });
  },
);
