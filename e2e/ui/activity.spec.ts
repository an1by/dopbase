import { about, expect, step, test, useServer } from "../harness/index.ts";
import { openFromSidebar } from "./support.ts";

// A second person makes changes, so people management is on.
const app = useServer({ env: { DOPBASE_RBAC: "true" } });

test(
  "recent changes show on the environment's Activity tab",
  {
    tag: "@audit",
    annotation: about(
      "After a secret is created, updated and another deleted, the environment's Activity tab lists each change with who made it and which key.",
    ),
  },
  async ({ page }) => {
    const env = await app.make.environment({ name: "dev" });
    await app.make.secret(env, "API_KEY");
    await app.make.secret(env, "API_KEY");
    await app.make.secret(env, "OLD_KEY");
    await app.api.must(
      "DELETE",
      `/environments/${env.id}/secrets/OLD_KEY`,
      undefined,
      { record: false },
    );
    await app.signIn(page);

    await step("Open dev and click Activity", async () => {
      await page.goto(`/projects/${env.projectName}/dev/secrets`);
      await page.getByRole("link", { name: "Activity", exact: true }).click();
      await expect(page).toHaveURL(`/projects/${env.projectName}/dev/activity`);
    });
    await step("Each change is listed with its key", async () => {
      for (const [action, key] of [
        ["secret.deleted", "OLD_KEY"],
        ["secret.updated", "API_KEY"],
        ["secret.created", "API_KEY"],
      ]) {
        await expect(
          page.getByRole("row", {
            name: new RegExp(`${action} root@dopbase\\.com dev ${key}`),
          }),
        ).toBeVisible();
      }
    });
    await step("Click Open in audit log", async () => {
      await page.getByRole("link", { name: "Open in audit log" }).click();
      await expect(page).toHaveURL(/\/audit\?/);
      await expect(
        page.getByRole("heading", { name: "Audit log" }),
      ).toBeVisible();
    });
  },
);

test(
  "the audit log filters by actor and action",
  {
    tag: "@audit",
    annotation: about(
      "With changes from root and from a member, filtering /audit by the member and by secret.updated leaves only the member's update.",
    ),
  },
  async ({ page }) => {
    const env = await app.make.environment({ name: "dev" });
    const member = await app.make.user({ role: "Member" });
    await app.api.must(
      "PUT",
      "/grants",
      {
        principalType: "user",
        principalId: member.id,
        scopeType: "project",
        scope: env.projectName,
        level: "write",
      },
      { record: false },
    );
    await app.make.secret(env, "API_KEY");
    const asMember = await app.apiAs(member);
    await asMember.must(
      "PUT",
      `/environments/${env.id}/secrets/API_KEY`,
      { value: app.value() },
      { record: false },
    );
    await asMember.must(
      "PUT",
      `/environments/${env.id}/secrets/MEMBER_KEY`,
      { value: app.value() },
      { record: false },
    );
    await app.signIn(page);

    await step("Open the audit log", async () => {
      await openFromSidebar(page, "Audit log");
      await expect(page).toHaveURL(/\/audit$/);
    });
    await step(`Filter by actor ${member.email}`, async () => {
      await page.getByRole("button", { name: "Filter by Actor" }).click();
      await page.getByRole("menuitem", { name: member.email }).click();
    });
    await step("Only the member's events are listed", async () => {
      await expect(page.getByText(`Actor: ${member.email}`)).toBeVisible();
      const rows = page.getByRole("row", { name: /^just now / });
      await expect(
        rows
          .filter({ hasText: "secret.created" })
          .filter({ hasText: member.email }),
      ).toHaveCount(1);
      await expect(rows.filter({ hasText: "root@dopbase.com" })).toHaveCount(0);
    });
    await step("Filter by action secret.updated", async () => {
      await page.getByRole("button", { name: "Filter by Action" }).click();
      await page
        .getByRole("menuitem", { name: "secret.updated", exact: true })
        .click();
    });
    await step("Only the member's update is left", async () => {
      await expect(page.getByText("Action: secret.updated")).toBeVisible();
      const rows = page.getByRole("row", { name: /^just now / });
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText(
        `secret.updated${member.email}${env.projectName}/dev`,
      );
    });
  },
);

test(
  "an audit event opens in a side panel and Verify chain passes",
  {
    tag: "@audit",
    annotation: about(
      "Clicking an event in /audit opens it in a side panel that says the hash chain checks out up to it; Verify chain reports the whole log verified; an action filter is kept in the address, so it survives a reload.",
    ),
  },
  async ({ page }) => {
    const env = await app.make.environment({ name: "dev" });
    await app.make.secret(env, "API_KEY");
    await app.signIn(page);

    await step("Open the audit log", async () => {
      await openFromSidebar(page, "Audit log");
      await expect(page).toHaveURL(/\/audit$/);
    });
    await step("Click the newest secret.created event", async () => {
      await page
        .getByTestId("audit-row")
        .filter({ hasText: "secret.created" })
        .first()
        .click();
    });
    await step("The side panel says the chain vouches for it", async () => {
      await expect(page.getByTestId("audit-event")).toBeVisible();
      await expect(page.getByTestId("audit-chain")).toContainText(
        /Chain verified up to #\d+/,
      );
      await page.keyboard.press("Escape");
    });
    await step("Click Verify chain", async () => {
      await page.getByTestId("verify-chain").click();
    });
    await step("The whole log is verified", async () => {
      await expect(page.getByTestId("chain-summary")).toContainText(
        /Chain verified up to #\d+\. \d+ records? checked\./,
      );
    });
    await step("Filter by action secret.created, then reload", async () => {
      await page.getByRole("button", { name: "Filter by Action" }).click();
      await page
        .getByRole("menuitem", { name: "secret.created", exact: true })
        .click();
      await expect(page.getByText("Action: secret.created")).toBeVisible();
      await page.reload();
    });
    await step("The filter is still applied", async () => {
      await expect(page).toHaveURL(/action=secret\.created/);
      await expect(page.getByText("Action: secret.created")).toBeVisible();
    });
  },
);
