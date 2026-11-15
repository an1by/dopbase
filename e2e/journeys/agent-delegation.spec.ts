import { grant, printVar, tempDir, tokenEnv } from "../harness/helpers.ts";
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

// People with grants, and AI agents owned by them, need RBAC on.
const app = useServer({ env: { DOPBASE_RBAC: "true" } });

test(
  "an AI agent reads what its owner gave it and never more than the owner",
  {
    tag: "@agents",
    annotation: about(
      "A person makes an AI agent in the Admin UI and gives it read on one environment; the agent's token reads that environment with `dopbase run`, can't write or reach more than its owner even when root grants it more, and loses access the moment its owner does.",
    ),
  },
  async ({ newContext, page }) => {
    const project = await app.make.project(app.uniq("billing"));
    const dev = await app.make.environment({ project, name: "dev" });
    const prod = await app.make.environment({ project, name: "prod" });
    const apiKey = await app.make.secret(dev, "API_KEY");
    await app.make.secret(prod, "API_KEY");
    const owner = await app.make.user({ role: "Member" });
    await grant(app, owner, "read", { environment: dev.id });
    const agentName = app.uniq("review-bot");
    let agentId = "";
    let token = "";

    await step(
      "The owner adds the AI agent on the AI agents page",
      async () => {
        await app.signIn(page, owner);
        await confirmPasswordWhenAsked(page, owner.password);
        await page.goto("/agents");
        await page.getByTestId("add-agent").click();
        const dialog = page.getByRole("dialog", { name: "Add AI agent" });
        await dialog.getByLabel("Name").fill(agentName);
        await dialog.getByRole("button", { name: "Add agent" }).click();
        await expect(page).toHaveURL(/\/agents\/agt_[^/]+/);
        agentId = new URL(page.url()).pathname.split("/")[2]!;
        await expect(
          page.getByText(`${agentName} doesn't reach any project yet.`),
        ).toBeVisible();
      },
    );

    await step(
      "The owner gives it Read on dev, and can't offer more than they hold",
      async () => {
        await page.getByTestId("give-access").click();
        await page.getByTestId("project-picker").click();
        await page
          .getByTestId("project-choice")
          .filter({ hasText: project.name })
          .click();
        await page
          .getByRole("radiogroup", { name: "Where" })
          .getByText("Some environments", { exact: true })
          .click();
        await page
          .getByTestId("environment-choices")
          .getByText("dev", { exact: true })
          .click();
        const levels = page.getByRole("radiogroup", { name: "Level" });
        await expect(
          levels.getByRole("radio", { name: /^Write/ }),
        ).toBeDisabled();
        await levels.getByText("Read", { exact: true }).click();
        await page.getByTestId("give-access-submit").click();
        await expect(page.getByTestId("grants-table")).toBeVisible();
        await expect(page.getByTestId("grant-row")).toHaveCount(1);
        await expect(
          page.getByRole("checkbox", { name: `Select ${dev.ref}` }),
        ).toBeAttached();
        await expect(page.getByTestId("grant-row")).toContainText("Read");
      },
    );

    await step("The owner creates the agent's token with Write", async () => {
      await page
        .getByRole("navigation", { name: "Agent sections" })
        .getByRole("link", { name: "Tokens" })
        .click();
      await page.getByTestId("new-agent-token").click();
      const dialog = page.getByRole("dialog", {
        name: `New token for ${agentName}`,
      });
      await dialog.getByRole("textbox", { name: "Name" }).fill("review-token");
      await dialog
        .getByRole("radiogroup", { name: "Can" })
        .getByText("Write", { exact: true })
        .click();
      const copy = page.getByRole("dialog", { name: "Copy the agent's token" });
      await dialog.getByRole("button", { name: "Create token" }).click();
      await expect(copy).toBeVisible();
      token = await copy.getByLabel("Generated token").inputValue();
      expect(token).toMatch(/^dpp_/);
      await copy.getByRole("button", { name: "I've stored it" }).click();
      await expect(page.getByTestId("agent-token-row")).toContainText(
        "review-token",
      );
    });

    const agentBox = await tempDir(app, "agent");
    const asAgent = (args: string[], stdin?: string) =>
      app.cliRaw(args, { env: tokenEnv(app, token, agentBox), stdin });

    await step(
      "The agent runs `dopbase run` on dev and gets API_KEY",
      async () => {
        const out = await asAgent([
          "run",
          dev.ref,
          "--",
          ...printVar("API_KEY"),
        ]).stdout();
        expect(out).toBe(apiKey);
      },
    );

    await step(
      "`dopbase access` with the agent's token shows read on dev only",
      async () => {
        const out = await asAgent(["access"]).stdout();
        expect(out).toMatch(new RegExp(`^${dev.ref}\\s+read\\b`, "m"));
        expect(out).not.toContain(prod.ref);
      },
    );

    await step(
      "A Write token still can't change dev, since the agent only has read",
      async () => {
        const out = await asAgent(
          ["secret", "set", dev.ref, "API_KEY", "--stdin"],
          app.value(),
        ).fails();
        expect(out.stderr).toContain("AUTHORIZATION_DENIED");
      },
    );

    await step(
      "Root grants the agent Write on dev and Read on prod through the API",
      async () => {
        for (const [env, level] of [
          [dev, "write"],
          [prod, "read"],
        ] as const) {
          await app.api.must("PUT", "/grants", {
            principalType: "agent",
            principalId: agentId,
            scopeType: "environment",
            scope: env.id,
            level,
          });
        }
      },
    );

    await step(
      "The agent's page lists both grants and says it never gets more than its owner",
      async () => {
        await page.goto(`/agents/${agentId}`);
        await expect(page.getByTestId("grant-row")).toHaveCount(2);
        await expect(page.getByTestId("access-grants")).toContainText(
          `never more than ${owner.email} does`,
        );
      },
    );

    await step(
      "`dopbase access` with the agent's token shows both held back to the owner's level",
      async () => {
        const out = await asAgent(["access"]).stdout();
        expect(out).toMatch(
          new RegExp(`^${dev.ref}\\s+read \\(granted write\\)`, "m"),
        );
        expect(out).toMatch(
          new RegExp(`^${prod.ref}\\s+no access \\(granted read\\)`, "m"),
        );
      },
    );

    await step(
      "The agent still can't write dev or read prod, because its owner can't",
      async () => {
        const write = await asAgent(
          ["secret", "set", dev.ref, "API_KEY", "--stdin"],
          app.value(),
        ).fails();
        expect(write.stderr).toContain("AUTHORIZATION_DENIED");
        const run = await asAgent([
          "run",
          prod.ref,
          "--",
          ...printVar("API_KEY"),
        ]).fails();
        expect(run.stdout).toBe("");
        const api = await app.apiWithToken(token);
        const res = await api.get(`/environments/${prod.id}/secrets`);
        expect([403, 404]).toContain(res.status);
        await api.dispose();
        const current = await app.api.must(
          "GET",
          `/environments/${dev.id}/secrets/API_KEY`,
          undefined,
          { record: false },
        );
        expect(current.version).toBe(1);
      },
    );

    const rootContext = await newContext("root", { baseURL: app.url });
    const rootPage = await rootContext.newPage();
    try {
      await stepOn(
        rootPage,
        "Root removes the owner's access to dev on the project's Access tab",
        async () => {
          await app.signIn(rootPage);
          await confirmPasswordWhenAsked(rootPage);
          await rootPage.goto(`/projects/${project.name}/access`);
          await rootPage
            .getByRole("button", { name: `Actions for ${owner.email}` })
            .click();
          await rootPage
            .getByRole("menuitem", { name: "Remove access" })
            .click();
          const confirm = rootPage.getByRole("dialog", {
            name: "Remove access",
          });
          await confirm.getByRole("button", { name: "Remove access" }).click();
          await expect(confirm).toBeHidden();
          await expect(
            rootPage.getByRole("button", {
              name: `Actions for ${owner.email}`,
            }),
          ).toHaveCount(0);
        },
      );
    } finally {
      await rootContext.close();
    }

    await step("The agent's next run on dev is refused", async () => {
      const run = await asAgent([
        "run",
        dev.ref,
        "--",
        ...printVar("API_KEY"),
      ]).fails();
      expect(run.stdout).not.toContain(apiKey);
      const api = await app.apiWithToken(token);
      const res = await api.get(`/environments/${dev.id}/secrets`);
      expect([403, 404]).toContain(res.status);
      await api.dispose();
    });

    await step(
      "`dopbase access` with the agent's token shows no access left on dev",
      async () => {
        const out = await asAgent(["access"]).stdout();
        expect(out).toMatch(
          new RegExp(`^${dev.ref}\\s+no access \\(granted write\\)`, "m"),
        );
      },
    );
  },
);
