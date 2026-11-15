import { grant, printVar } from "../harness/helpers.ts";
import { about, expect, step, test, useServer } from "../harness/index.ts";

// Adding a teammate and giving them access needs RBAC on.
const app = useServer({ env: { DOPBASE_RBAC: "true" } });

test(
  "a secret rotated with the CLI, the UI and the API keeps one history",
  {
    tag: "@secrets",
    annotation: about(
      "One secret changed from the CLI, the Admin UI and the API keeps a single version history, `dopbase run` always gets the current value, and the audit log records each change with who made it.",
    ),
  },
  async ({ page }) => {
    const env = await app.make.environment({
      project: await app.make.project(app.uniq("billing")),
      name: "dev",
    });
    const ops = await app.make.user({ role: "Member" });
    await grant(app, ops, "write", { environment: env.id });
    const first = app.value();
    const second = app.value();
    const history = page.getByRole("dialog", { name: "Secrets history" });
    const runAsOps = () =>
      app
        .cli(["run", env.ref, "--", ...printVar("API_KEY")], { as: ops })
        .stdout();

    await step(
      "An engineer with write access sets API_KEY with `dopbase secret set`",
      async () => {
        await app
          .cli(["secret", "set", env.ref, "API_KEY", "--stdin"], {
            as: ops,
            stdin: first,
          })
          .ok();
      },
    );

    await step("`dopbase run` gets the first value", async () => {
      expect(await runAsOps()).toBe(first);
    });

    await step("Root changes API_KEY in the Admin UI", async () => {
      await app.signIn(page);
      await page.goto(`/projects/${env.projectName}/dev/secrets`);
      await page.getByRole("button", { name: "Actions for API_KEY" }).click();
      await page.getByRole("menuitem", { name: "Edit value" }).click();
      const form = page.getByRole("dialog", { name: "Update secret" });
      await expect(form.getByTestId("secret-key-field")).toContainText("v1");
      await form.getByLabel("Value").fill(second);
      await form.getByRole("button", { name: "Save new version" }).click();
      await expect(form).toBeHidden();
    });

    await step(
      "The UI history shows both versions and who saved each",
      async () => {
        await page.getByRole("button", { name: "Actions for API_KEY" }).click();
        await page.getByRole("menuitem", { name: "History" }).click();
        const v1 = history.getByTestId("history-row-1");
        const v2 = history.getByTestId("history-row-2");
        await expect(v1).toContainText("Created");
        await expect(v1).toContainText(ops.email);
        await expect(v2).toContainText("Updated");
        await expect(v2).toContainText("root@dopbase.com");
        await expect(v2).toContainText("current");
        await history.getByRole("button", { name: "Close dialog" }).click();
      },
    );

    await step("`dopbase secret history` lists the same two", async () => {
      const out = await app
        .cli(["secret", "history", env.ref, "API_KEY"], { as: ops })
        .stdout();
      expect(out).toMatch(/^v2\s+updated\s+root@dopbase\.com.*current$/m);
      expect(out).toMatch(new RegExp(`^v1\\s+created\\s+${ops.email}`, "m"));
    });

    await step("`dopbase run` now gets the value set in the UI", async () => {
      expect(await runAsOps()).toBe(second);
    });

    let token = "";
    await step(
      "The engineer makes a write token for a rotation script with `dopbase token personal create`",
      async () => {
        const created = await app
          .cli(
            [
              "--json",
              "token",
              "personal",
              "create",
              "--name",
              app.uniq("rotate"),
              "--level",
              "write",
              "--env",
              env.ref,
              "--expires-in",
              "1h",
            ],
            { as: ops },
          )
          .json();
        token = created.plaintextToken;
        expect(token).toMatch(/^dpp_/);
      },
    );

    await step(
      "The script rolls API_KEY back to v1 through the API",
      async () => {
        const api = await app.apiWithToken(token);
        const rolled = await api.must(
          "POST",
          `/environments/${env.id}/secrets/API_KEY/rollback`,
          { version: 1, expectedVersion: 2 },
        );
        expect(rolled).toMatchObject({
          version: 3,
          sourceVersion: 1,
          previousVersion: 2,
        });
        await api.dispose();
      },
    );

    await step("`dopbase run` picks up the rolled-back value", async () => {
      expect(await runAsOps()).toBe(first);
    });

    await step("The UI history shows the rollback as v3", async () => {
      await page.reload();
      await page.getByRole("button", { name: "Actions for API_KEY" }).click();
      await page.getByRole("menuitem", { name: "History" }).click();
      const v3 = history.getByTestId("history-row-3");
      await expect(v3).toContainText("Rolled back from v1");
      await expect(v3).toContainText(ops.email);
      await expect(v3).toContainText("current");
      await history.getByRole("button", { name: "Close dialog" }).click();
    });

    await step(
      "`dopbase audit list` has the CLI set, the UI change and the API rollback",
      async () => {
        const listed = await app
          .cli([
            "--json",
            "audit",
            "list",
            "--environment",
            env.ref,
            "--limit",
            "200",
          ])
          .json();
        const events: {
          action: string;
          actorLabel: string;
          actorType: string;
        }[] = listed.items;
        const who = (action: string) =>
          events
            .filter((event) => event.action === action)
            .map((event) => `${event.actorLabel} ${event.actorType}`);
        expect(who("secret.created")).toEqual([
          expect.stringContaining(ops.email),
        ]);
        expect(who("secret.updated")).toEqual([
          expect.stringContaining("root@dopbase.com"),
        ]);
        expect(who("secret.rolled_back")).toEqual([
          `${ops.email} personal_token`,
        ]);
      },
    );

    await step("The Activity tab lists the same changes", async () => {
      await page.goto(`/projects/${env.projectName}/dev/activity`);
      const table = page.getByTestId("activity-table");
      await expect(table).toContainText("secret.created");
      await expect(table).toContainText("secret.updated");
      await expect(table).toContainText("secret.rolled_back");
    });
  },
);
