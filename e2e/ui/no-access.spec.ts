import { about, expect, step, test, useServer } from "../harness/index.ts";

// Granting a person access needs people management on.
const app = useServer({ env: { DOPBASE_RBAC: "true" } });

test(
  "a member sees only the projects they were given",
  {
    tag: "@access",
    annotation: about(
      "A Member granted Read on one project sees that project on Projects and not the other, and the sidebar offers no admin pages.",
    ),
  },
  async ({ page }) => {
    const shared = await app.make.environment({ name: "dev" });
    const hidden = await app.make.project();
    const member = await app.make.user({ role: "Member" });
    await app.api.must(
      "PUT",
      "/grants",
      {
        principalType: "user",
        principalId: member.id,
        scopeType: "project",
        scope: shared.projectName,
        level: "read",
      },
      { record: false },
    );

    await step("Sign in as the member", async () => {
      await app.signIn(page, member);
    });
    await step(`Projects lists ${shared.projectName} only`, async () => {
      await expect(page).toHaveURL(/\/projects$/);
      await expect(
        page.getByRole("link", {
          name: `Open secrets in ${shared.projectName} / dev`,
        }),
      ).toBeVisible();
      await expect(page.getByText(hidden.name)).toHaveCount(0);
    });
    await step("The sidebar has no Users or Backups", async () => {
      const nav = page.getByRole("navigation", { name: "Primary" });
      await expect(nav.getByRole("link", { name: "Projects" })).toBeVisible();
      await expect(nav.getByRole("link", { name: "Users" })).toHaveCount(0);
      await expect(nav.getByRole("link", { name: "Backups" })).toHaveCount(0);
    });
    await step(`Open ${shared.projectName} dev, read-only`, async () => {
      await page
        .getByRole("link", {
          name: `Open secrets in ${shared.projectName} / dev`,
        })
        .click();
      await expect(page).toHaveURL(
        `/projects/${shared.projectName}/dev/secrets`,
      );
      await expect(
        page.getByText("adding secrets needs write access"),
      ).toBeVisible();
    });
  },
);

test(
  "a member opening Backups gets the no-access page",
  {
    tag: "@access",
    annotation: about(
      "A direct link to /backups shows 'You don't have access to Backups' at the same address, and Back to projects leaves it.",
    ),
  },
  async ({ page }) => {
    const member = await app.make.user({ role: "Member" });
    await app.signIn(page, member);

    await step("Open /backups as a member", async () => {
      await page.goto("/backups");
    });
    await step("The no-access page names Backups", async () => {
      await expect(page).toHaveURL(/\/backups$/);
      await expect(
        page.getByRole("heading", { name: "You don't have access to Backups" }),
      ).toBeVisible();
    });
    await step("Click Back to projects", async () => {
      await page.getByRole("button", { name: "Back to projects" }).click();
      await expect(page).toHaveURL(/\/projects$/);
    });
  },
);
