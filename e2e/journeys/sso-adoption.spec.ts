import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { grant, printVar } from "../harness/helpers.ts";
import {
  about,
  expect,
  ROOT,
  ROOT_EMAIL,
  step,
  stepOn,
  test,
  useServer,
} from "../harness/index.ts";
import { startBrowserLogin } from "../harness/server.ts";
import { pty } from "../harness/terminal.ts";
import { confirmPasswordWhenAsked } from "../ui/support.ts";

// SSO needs the feature flag; adding a person needs RBAC.
const app = useServer({
  sso: true,
  env: { DOPBASE_SSO: "true", DOPBASE_RBAC: "true" },
});

test(
  "a team moves to single sign-on, in the browser and the CLI",
  {
    tag: "@sso",
    annotation: about(
      "Root sets up an OpenID Connect provider in the Admin UI and a teammate links their identity; once SSO is required, the teammate's password stops working and both the browser and `dopbase login --browser` go through the provider.",
    ),
  },
  async ({ newContext, page }) => {
    const oidc = app.oidc!;
    const env = await app.make.environment({
      project: await app.make.project(app.uniq("billing")),
      name: "dev",
    });
    const apiKey = await app.make.secret(env, "API_KEY");
    const member = await app.make.user({ role: "Member" });
    await grant(app, member, "read", { environment: env.id });
    const status = page.getByTestId("sso-status");

    await step(
      "Root enters the provider on the Single sign-on page",
      async () => {
        await app.signIn(page);
        await confirmPasswordWhenAsked(page);
        await page.goto("/sso");
        await expect(status).toHaveText("Not set up");
        const form = page.getByTestId("sso-form");
        await form.getByLabel("Issuer URL").fill(oidc.issuer);
        await form.getByLabel("Client ID").fill(oidc.clientId);
        await form.getByLabel("Client secret").fill(oidc.clientSecret);
        await form.getByLabel("Button label").fill("Acme SSO");
        await form.getByRole("button", { name: "Save", exact: true }).click();
        await expect(status.getByText("Untested")).toBeVisible();
      },
    );

    await step(
      "Root's test sign-in at the provider links root's identity",
      async () => {
        oidc.nextUser({ email: ROOT_EMAIL, emailVerified: true });
        await page.getByTestId("sso-test").click();
        await page.waitForURL(/\/sso\?(linked|sso_error)=/);
        expect(new URL(page.url()).search).toBe("?linked=1");
        await expect(status).toHaveText("Off");
      },
    );

    await step("Root turns single sign-on on", async () => {
      await page.getByTestId("sso-toggle").click();
      await expect(status.getByText("On", { exact: true })).toBeVisible();
    });

    const clientDir = join(app.server.root, app.uniq("member-cli"));
    await mkdir(clientDir, { recursive: true });
    const cliEnv = { ...app.server.cliEnv, DOPBASE_DATA_DIR: clientDir };
    const memberContext = await newContext("teammate", { baseURL: app.url });
    const memberPage = await memberContext.newPage();
    try {
      await stepOn(
        memberPage,
        "The teammate signs in with their password and links Acme SSO on their account",
        async () => {
          await memberPage.goto("/login");
          await memberPage.getByLabel("Email").fill(member.email);
          await memberPage
            .getByLabel("Password", { exact: true })
            .fill(member.password);
          await memberPage.getByRole("button", { name: "Sign in" }).click();
          await expect(memberPage).toHaveURL(/\/projects/);
          await memberPage.goto("/account");
          oidc.nextUser({ email: member.email, emailVerified: true });
          await memberPage
            .getByRole("button", { name: "Link Acme SSO" })
            .click();
          await expect(memberPage.getByTestId("sso-link-card")).toContainText(
            `Linked to Acme SSO as ${member.email}`,
          );
        },
      );

      await step("Root requires single sign-on", async () => {
        await page.getByTestId("sso-require").click();
        const confirm = page.getByRole("dialog", {
          name: "Require single sign-on?",
        });
        await confirm
          .getByRole("button", { name: "Require single sign-on" })
          .click();
        await expect(confirm).toBeHidden();
        await expect(
          page.getByText("Single sign-on is now required."),
        ).toBeVisible();
      });

      await stepOn(
        memberPage,
        "The teammate's password stops working in the browser, the CLI and the API",
        async () => {
          // Requiring SSO signed them out everywhere.
          await memberPage.goto("/projects");
          await expect(memberPage).toHaveURL(/\/login/);
          await memberPage.getByLabel("Email").fill(member.email);
          await memberPage
            .getByLabel("Password", { exact: true })
            .fill(member.password);
          await memberPage.getByRole("button", { name: "Sign in" }).click();
          await expect(memberPage.getByTestId("login-error")).toContainText(
            "Password sign-in is turned off.",
          );
          await expect(memberPage).toHaveURL(/\/login/);

          const cli = await pty(["login", "--password"], {
            env: cliEnv,
            steps: [
              { wait: "Email:", send: `${member.email}\r` },
              { wait: "Password:", send: `${member.password}\r` },
            ],
          });
          expect(cli.code, cli.output).not.toBe(0);
          expect(cli.output).toContain("PASSWORD_LOGIN_DISABLED");

          const anonymous = await app.anonymousApi();
          const login = await anonymous.post("/auth/login", {
            email: member.email,
            password: member.password,
            sessionKind: "browser",
          });
          expect(login.ok).toBe(false);
          const rootLogin = await anonymous.post("/auth/login", {
            email: ROOT.email,
            password: ROOT.password,
            sessionKind: "browser",
          });
          expect(rootLogin.ok, "root keeps its password").toBe(true);
        },
      );

      await stepOn(
        memberPage,
        "The teammate signs in with Acme SSO instead",
        async () => {
          oidc.nextUser({ email: member.email, emailVerified: true });
          await memberPage
            .getByTestId("sso-login")
            .getByText("Continue with Acme SSO")
            .click();
          await expect(memberPage).toHaveURL(/\/projects/);
          await expect(memberPage.getByTestId("project-tree")).toContainText(
            env.projectName,
          );
        },
      );

      await stepOn(
        memberPage,
        "`dopbase login --browser` is approved in the SSO session",
        async () => {
          const login = startBrowserLogin((run) =>
            app.cliRaw(["login", "--browser"], {
              ...run,
              env: cliEnv,
              timeoutMs: 45_000,
            }),
          );
          try {
            const { url, code } = await login.prompt;
            await memberPage.goto(url);
            // The page checks the session first; wait until it shows either
            // the review or the code form before deciding which one it is.
            const review = memberPage.getByTestId("cli-review");
            await expect(
              review.or(memberPage.getByTestId("cli-code-form")),
            ).toBeVisible();
            if (!(await review.isVisible())) {
              await memberPage.getByRole("textbox").first().fill(code);
              await memberPage
                .getByRole("button", { name: "Continue" })
                .click();
            }
            await expect(
              memberPage.getByTestId("cli-account-email"),
            ).toHaveText(member.email);
            await memberPage.getByTestId("cli-approve").click();
            await expect(memberPage.getByTestId("cli-done")).toBeVisible();
            await login.run.ok();
          } finally {
            login.cancel();
            await login.run;
          }
        },
      );
    } finally {
      await memberContext.close();
    }

    await step(
      "The CLI signed in through SSO runs the app with API_KEY",
      async () => {
        const status = await app.cliRaw(["access"], { env: cliEnv }).stdout();
        expect(status).toContain(member.email);
        const out = await app
          .cliRaw(["run", env.ref, "--", ...printVar("API_KEY")], {
            env: cliEnv,
          })
          .stdout();
        expect(out).toBe(apiKey);
      },
    );
  },
);

// Runs after the journey above, while SSO is still required.
test(
  "the password-refused message names the button on the page",
  {
    tag: "@sso",
    annotation: about(
      "Once SSO is required, a refused password tells the person to use the button the page shows: 'Continue with Acme SSO'.",
    ),
  },
  async ({ page }) => {
    const member = await app.make.user({ role: "Member" });
    await step("A teammate tries their password", async () => {
      await page.goto("/login");
      await page.getByLabel("Email").fill(member.email);
      await page.getByLabel("Password", { exact: true }).fill(member.password);
      await page.getByRole("button", { name: "Sign in" }).click();
    });
    await step("The message names the button they can see", async () => {
      await expect(page.getByTestId("sso-login")).toHaveText(
        "Continue with Acme SSO",
      );
      await expect(page.getByTestId("login-error")).toContainText(
        'Use "Continue with Acme SSO" above.',
      );
    });
  },
);
