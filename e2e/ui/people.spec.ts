import { about, expect, step, test, useServer } from "../harness/index.ts";
import {
  confirmPasswordWhenAsked,
  dialog,
  giveAccess,
  openFromSidebar,
  setCheckbox,
  testPassword,
} from "./support.ts";

// People, groups and custom roles are off by default.
const app = useServer({
  env: { DOPBASE_RBAC: "true", DOPBASE_RBAC_ROLES: "true" },
});

test(
  "add a person, change their role, give project access and disable them",
  {
    tag: ["@people", "@access"],
    annotation: about(
      "Add user creates a Member with a temporary password; Edit makes them an Admin, Give access grants Read on a project, and Disable account turns them off.",
    ),
  },
  async ({ page }) => {
    const project = await app.make.project();
    const email = `${app.uniq("dana")}@dopbase.com`;
    await app.signIn(page);
    await confirmPasswordWhenAsked(page);

    await step("Open Users and click Add user", async () => {
      await openFromSidebar(page, "Users");
      await expect(page).toHaveURL(/\/users$/);
      await page.getByRole("button", { name: "Add user" }).click();
    });
    await step(`Add ${email} as a Member`, async () => {
      const add = dialog(page, "Add user");
      await add.getByLabel("Email").fill(email);
      await add
        .getByLabel("Temporary password", { exact: true })
        .fill(testPassword());
      await add.getByText("Member", { exact: true }).click();
      await add.getByRole("button", { name: "Add user" }).click();
      await expect(add).toBeHidden();
    });
    await step("Their page opens on Access, with no access yet", async () => {
      await expect(page).toHaveURL(/\/users\/[^/]+\/access$/);
      await expect(page.getByRole("heading", { name: email })).toBeVisible();
      await expect(
        page.getByText(`${email} doesn't reach any project yet.`),
      ).toBeVisible();
    });
    await step("Click Edit and make them an Admin", async () => {
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      const edit = dialog(page, `Edit ${email}`);
      await edit.getByText("Admin", { exact: true }).click();
      await edit.getByRole("button", { name: "Save" }).click();
      await expect(edit).toBeHidden();
    });
    await step("They are an Admin now", async () => {
      await expect(page.getByText(/^Admin · /)).toBeVisible();
    });
    await step("Click Give access", async () => {
      await page.getByRole("button", { name: "Give access" }).click();
      await expect(page).toHaveURL(/\/users\/[^/]+\/access\/new$/);
      await expect(
        page.getByRole("heading", { name: "Give access" }),
      ).toBeVisible();
    });
    await step(`Give Read on ${project.name}`, async () => {
      await giveAccess(page, { project: project.name, level: "Read" });
    });
    await step(`Access lists ${project.name} at Read`, async () => {
      await expect(page).toHaveURL(/\/users\/[^/]+\/access$/);
      await expect(
        page.getByRole("row", { name: new RegExp(`${project.name}.*Read`) }),
      ).toBeVisible();
    });
    await step("Open Danger zone and click Disable account", async () => {
      await page.getByRole("link", { name: "Danger zone" }).click();
      await page.getByRole("button", { name: "Disable account" }).click();
      await dialog(page, `Disable ${email}?`)
        .getByRole("button", { name: "Disable account" })
        .click();
    });
    await step("The account is marked Disabled", async () => {
      await expect(
        page.getByRole("button", { name: "Turn back on" }),
      ).toBeVisible();
      await expect(page.getByText("Disabled", { exact: true })).toBeVisible();
    });
    await step("Users lists them as disabled", async () => {
      await openFromSidebar(page, "Users");
      await expect(
        page.getByRole("row", { name: new RegExp(`^${email}.*disabled`) }),
      ).toBeVisible();
    });
  },
);

test(
  "create an AI agent, give it access and make its token",
  {
    tag: ["@people", "@access"],
    annotation: about(
      "Add AI agent creates an agent owned by root; Give access grants it Read on a project and New token shows its token once.",
    ),
  },
  async ({ page }) => {
    const project = await app.make.project();
    const name = app.uniq("review-bot");
    await app.signIn(page);
    await confirmPasswordWhenAsked(page);

    await step("Open AI agents and click Add AI agent", async () => {
      await openFromSidebar(page, "AI agents");
      await expect(page).toHaveURL(/\/agents$/);
      await page.getByRole("button", { name: "Add AI agent" }).click();
    });
    await step(`Name it ${name} and click Add agent`, async () => {
      const add = dialog(page, "Add AI agent");
      await add.getByLabel("Name").fill(name);
      await add.getByRole("button", { name: "Add agent" }).click();
      await expect(add).toBeHidden();
    });
    await step("The agent's page opens", async () => {
      await expect(page).toHaveURL(/\/agents\/[^/]+$/);
      await expect(page.getByRole("heading", { name })).toBeVisible();
    });
    await step("Click Give access", async () => {
      await page.getByRole("button", { name: "Give access" }).click();
      await expect(page).toHaveURL(/\/agents\/[^/]+\/access\/new$/);
    });
    await step(`Give Read on ${project.name}`, async () => {
      await giveAccess(page, { project: project.name, level: "Read" });
    });
    await step(`Access lists ${project.name} at Read`, async () => {
      await expect(page).toHaveURL(/\/agents\/[^/]+$/);
      await expect(
        page.getByRole("row", { name: new RegExp(`${project.name}.*Read`) }),
      ).toBeVisible();
    });
    await step("Open Tokens and click New token", async () => {
      await page.getByRole("link", { name: "Tokens" }).click();
      await expect(page).toHaveURL(/\/agents\/[^/]+\/tokens$/);
      await page.getByRole("button", { name: "New token" }).click();
    });
    await step("Name the token and click Create token", async () => {
      const create = dialog(page, `New token for ${name}`);
      await create.getByRole("textbox", { name: "Name" }).fill(`${name}-token`);
      await create.getByRole("button", { name: "Create token" }).click();
    });
    const shown = dialog(page, "Copy the agent's token");
    await step("The token is shown once", async () => {
      await expect(
        shown.getByText("You won't see this token again"),
      ).toBeVisible();
      await expect(shown.getByLabel("Generated token")).not.toHaveValue("");
    });
    await step("Click I've stored it", async () => {
      await shown.getByRole("button", { name: "I've stored it" }).click();
      await expect(shown).toBeHidden();
    });
    await step("The token is listed as active", async () => {
      await expect(
        page.getByRole("row", { name: new RegExp(`^${name}.* active Read`) }),
      ).toBeVisible();
    });
  },
);

test(
  "a group with a member and a grant",
  {
    tag: ["@people", "@access"],
    annotation: about(
      "New group creates a group; Add members puts a person in it and Give access grants the group Write on a project.",
    ),
  },
  async ({ page }) => {
    const project = await app.make.project();
    const member = await app.make.user();
    const name = app.uniq("platform");
    await app.signIn(page);
    await confirmPasswordWhenAsked(page);

    await step("Open Groups and click New group", async () => {
      await openFromSidebar(page, "Groups");
      await expect(page).toHaveURL(/\/groups$/);
      await page.getByRole("button", { name: "New group" }).click();
    });
    await step(`Name it ${name} and click Create group`, async () => {
      const create = dialog(page, "New group");
      await create.getByLabel("Name", { exact: true }).fill(name);
      await create.getByRole("button", { name: "Create group" }).click();
      await expect(create).toBeHidden();
    });
    await step("The group's page opens with nobody in it", async () => {
      await expect(page).toHaveURL(/\/groups\/[^/]+$/);
      await expect(page.getByText(`Nobody is in ${name} yet.`)).toBeVisible();
    });
    await step(`Click Add members and pick ${member.email}`, async () => {
      await page.getByRole("button", { name: "Add members" }).click();
      const add = dialog(page, `Add members to ${name}`);
      await setCheckbox(
        add.getByRole("checkbox", { name: member.email }),
        true,
      );
      await add.getByRole("button", { name: "Add 1 member" }).click();
      await expect(add).toBeHidden();
    });
    await step(`${member.email} is a member`, async () => {
      await expect(
        page.getByRole("row", { name: new RegExp(`^${member.email}`) }),
      ).toBeVisible();
    });
    await step("Open Access and click Give access", async () => {
      await page.getByRole("link", { name: "Access" }).click();
      await page.getByRole("button", { name: "Give access" }).click();
      await expect(page).toHaveURL(/\/groups\/[^/]+\/access\/new$/);
    });
    await step(`Give Write on ${project.name}`, async () => {
      await giveAccess(page, { project: project.name, level: "Write" });
    });
    await step(`Access lists ${project.name} at Write`, async () => {
      await expect(page).toHaveURL(/\/groups\/[^/]+\/access$/);
      await expect(
        page.getByRole("row", { name: new RegExp(`${project.name}.*Write`) }),
      ).toBeVisible();
    });
  },
);

test(
  "create a custom role in the role editor",
  {
    tag: ["@people", "@access"],
    annotation: about(
      "New role takes a name, a reach and capabilities; Create role lists it on Roles and its page shows what was picked.",
    ),
  },
  async ({ page }) => {
    const name = app.uniq("Viewer");
    await app.signIn(page);

    await step("Open Roles and click New role", async () => {
      await openFromSidebar(page, "Roles");
      await expect(page).toHaveURL(/\/roles$/);
      await page.getByRole("button", { name: "New role" }).click();
      await expect(page).toHaveURL(/\/roles\/new$/);
    });
    await step(`Name it ${name}, reaching names only`, async () => {
      await page.getByRole("textbox", { name: "Name" }).fill(name);
      await page
        .getByRole("textbox", { name: "Description (optional)" })
        .fill("Sees key names and instance status");
      await page
        .getByRole("radiogroup", { name: "Reaches at most" })
        .getByRole("radio", { name: "Names only" })
        .click();
      await page
        .getByRole("radiogroup", { name: "Tokens can" })
        .getByRole("radio", { name: "Names only" })
        .click();
    });
    await step("Tick See instance status", async () => {
      await setCheckbox(
        page.getByRole("checkbox", { name: "See instance status" }),
        true,
      );
      await expect(page.getByText("2 of 14 picked.")).toBeVisible();
    });
    await step("Click Create role", async () => {
      await page.getByRole("button", { name: "Create role" }).click();
    });
    await step(`Roles lists ${name}`, async () => {
      await expect(page).toHaveURL(/\/roles$/);
      await expect(
        page.getByRole("row", { name: new RegExp(`^${name} .*Names only`) }),
      ).toBeVisible();
    });
    await step(`Open ${name}`, async () => {
      await page.getByRole("link", { name, exact: true }).click();
      await expect(page).toHaveURL(/\/roles\/[^/]+$/);
    });
    await step("The editor shows what was picked", async () => {
      await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue(
        name,
      );
      await expect(
        page
          .getByRole("radiogroup", { name: "Reaches at most" })
          .getByRole("radio", { name: "Names only" }),
      ).toBeChecked();
      await expect(
        page.getByRole("checkbox", { name: "See instance status" }),
      ).toBeChecked();
    });
  },
);
