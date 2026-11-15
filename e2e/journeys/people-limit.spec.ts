import { expectError, expectOk } from "../api/support.ts";
import { about, expect, step, test, useServer } from "../harness/index.ts";

// The limit applies to the whole server, so this file has one of its own:
// RBAC on and room for two active people. Root and AI agents don't count.
const app = useServer({
  env: { DOPBASE_RBAC: "true", DOPBASE_RBAC_MAX_USERS: "2" },
});

test(
  "the people limit holds across the API and the Users page",
  {
    tag: "@people",
    annotation: about(
      "With DOPBASE_RBAC_MAX_USERS=2, a third active person is refused with 409 USER_LIMIT_REACHED while AI agents can still be added; the Users page shows 2 of 2 and turns Add user off; disabling someone frees the spot, and enabling them while it's taken is refused again.",
    ),
  },
  async ({ page }) => {
    const ada = await step("Add the first person", async () => app.make.user());
    await step("Add the second person", async () => app.make.user());
    await step("A third person is 409 USER_LIMIT_REACHED", async () => {
      expectError(
        await app.api.post("/users", {
          email: `${app.uniq("third")}@dopbase.com`,
          password: "third-person-password-1",
          roleId: await app.make.roleId("Member"),
        }),
        409,
        "USER_LIMIT_REACHED",
      );
    });
    await step("An AI agent can still be added", async () => {
      expectOk(await app.api.post("/agents", { name: app.uniq("bot") }), 201);
    });
    await step(
      "Users shows 2 of 2 active users and Add user is off",
      async () => {
        await app.signIn(page);
        await page.goto("/users");
        await expect(page.getByTestId("user-limit")).toContainText(
          "2 of 2 active users",
        );
        await expect(page.getByTestId("add-user")).toBeDisabled();
        await expect(page.getByTestId("user-limit-full")).toBeVisible();
      },
    );
    await step("Disabling a person frees a spot", async () => {
      expectOk(await app.api.post(`/users/${ada.id}/disable`));
      const third = await app.make.user();
      expect(third.id).toBeTruthy();
    });
    await step(
      "Enabling the disabled person while the spot is taken is 409",
      async () => {
        expectError(
          await app.api.post(`/users/${ada.id}/enable`),
          409,
          "USER_LIMIT_REACHED",
        );
      },
    );
  },
);
