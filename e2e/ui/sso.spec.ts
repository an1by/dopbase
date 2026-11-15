import type { Browser } from "@playwright/test";
import { about, expect, step, test, useServer } from "../harness/index.ts";
import { confirmPasswordWhenAsked } from "./support.ts";

// The fake OIDC provider runs as app.oidc. Single sign-on and people
// management are off by default.
const app = useServer({
  sso: true,
  env: { DOPBASE_SSO: "true", DOPBASE_RBAC: "true" },
});

const PROVIDER = "Acme SSO";
const QUIET = { record: false } as const;

/**
 * Sets the fake provider up, tested and on, for tests that sign in with it.
 * The test sign-in that unlocks "Turn on" only runs in a browser, so it
 * happens in a separate context that the test's page never sees.
 */
async function readyProvider(browser: Browser): Promise<void> {
  const oidc = app.oidc!;
  const current = await app.api.send("GET", "/sso/provider", undefined, QUIET);
  if (current.data?.provider?.enabled) return;
  await app.api.must(
    "PUT",
    "/sso/provider",
    {
      preset: "generic",
      displayName: PROVIDER,
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      clientSecret: oidc.clientSecret,
    },
    QUIET,
  );
  const context = await browser.newContext({ baseURL: app.url });
  try {
    const page = await context.newPage();
    await app.signIn(page);
    oidc.nextUser({ email: "root@dopbase.com", emailVerified: true });
    await page.goto("/sso");
    await page.getByRole("button", { name: "Test sign-in" }).click();
    await expect(page.getByTestId("sso-status")).toHaveText("Off");
  } finally {
    await context.close();
  }
  await app.api.must("PUT", "/sso/provider/enabled", { enabled: true }, QUIET);
}

test(
  "set up the provider in the UI",
  {
    tag: "@sso",
    annotation: about(
      "Single sign-on saves the provider's issuer and client, a test sign-in at the provider marks it tested, and Turn on puts the button on the login page.",
    ),
  },
  async ({ page }) => {
    const oidc = app.oidc!;
    // Start from no provider, whatever ran before.
    await app.api.send("DELETE", "/sso/provider", undefined, QUIET);
    await app.signIn(page);
    await confirmPasswordWhenAsked(page);

    await step("Open Single sign-on", async () => {
      await page.goto("/sso");
      await expect(
        page.getByRole("heading", { name: "No provider yet" }),
      ).toBeVisible();
    });
    await step("Fill in the issuer, client and button label", async () => {
      await page.getByLabel("Issuer URL").fill(oidc.issuer);
      await page.getByLabel("Client ID").fill(oidc.clientId);
      await page
        .getByLabel("Client secret", { exact: true })
        .fill(oidc.clientSecret);
      await page.getByLabel("Button label").fill(PROVIDER);
    });
    await step("Click Save", async () => {
      await page.getByRole("button", { name: "Save", exact: true }).click();
    });
    await step("The provider is saved but untested", async () => {
      await expect(page.getByRole("heading", { name: PROVIDER })).toBeVisible();
      await expect(page.getByTestId("sso-status")).toHaveText("Untested");
      await expect(
        page.getByRole("button", { name: "Turn on" }),
      ).toBeDisabled();
    });
    await step("Click Test sign-in", async () => {
      oidc.nextUser({ email: "root@dopbase.com", emailVerified: true });
      await page.getByRole("button", { name: "Test sign-in" }).click();
    });
    await step("The test sign-in worked", async () => {
      // The page reads ?linked=1 and then drops it from the address.
      await expect(page).toHaveURL(/\/sso(\?linked=1)?$/);
      await expect(
        page.getByText(
          "Test sign-in worked. You can turn on single sign-on now.",
        ),
      ).toBeVisible();
      await expect(page.getByTestId("sso-status")).toHaveText("Off");
    });
    await step("Click Turn on", async () => {
      await page.getByRole("button", { name: "Turn on" }).click();
    });
    await step("Single sign-on is on", async () => {
      await expect(page.getByTestId("sso-status")).toHaveText("On");
      await expect(
        page.getByText(
          "Single sign-on is on. The sign-in page now shows the button.",
        ),
      ).toBeVisible();
    });
  },
);

test(
  "sign in with SSO",
  {
    tag: "@sso",
    annotation: about(
      "With the provider on, Continue with Acme SSO on the login page signs an existing person in through the provider and lands on Projects.",
    ),
  },
  async ({ page, browser }) => {
    await readyProvider(browser);
    const person = await app.make.user({ role: "Member" });
    app.oidc!.nextUser({ email: person.email, emailVerified: true });

    await step("Open the login page", async () => {
      await page.goto("/login");
    });
    await step(`Click Continue with ${PROVIDER}`, async () => {
      await page
        .getByRole("link", { name: `Continue with ${PROVIDER}` })
        .click();
    });
    await step("The provider sends them back signed in", async () => {
      await expect(page).toHaveURL(/\/projects$/);
      await expect(
        page.getByRole("button", { name: "Account menu" }),
      ).toContainText(person.email);
    });
  },
);

test(
  "link SSO on the account page",
  {
    tag: "@sso",
    annotation: about(
      "A person who signs in with a password links their provider account from Account, and the card then says it is linked.",
    ),
  },
  async ({ page, browser }) => {
    await readyProvider(browser);
    const person = await app.make.user({ role: "Member" });
    await app.signIn(page, person);

    await step("Open Account", async () => {
      await page.getByRole("button", { name: "Account menu" }).click();
      await page.getByRole("link", { name: "Account", exact: true }).click();
      await expect(page).toHaveURL(/\/account$/);
    });
    await step(`Click Link ${PROVIDER}`, async () => {
      app.oidc!.nextUser({ email: person.email, emailVerified: true });
      await page.getByRole("button", { name: `Link ${PROVIDER}` }).click();
    });
    await step("Account says single sign-on is linked", async () => {
      await expect(page).toHaveURL(/\/account(\?sso=linked)?$/);
      await expect(
        page.getByText("Single sign-on is linked. You can use it to sign in."),
      ).toBeVisible();
      await expect(page.getByText(`Linked to ${PROVIDER}`)).toBeVisible();
    });
  },
);

test(
  "the SSO confirmation page reports the provider's answer",
  {
    tag: "@sso",
    annotation: about(
      "/sso/confirmed is where the provider returns a confirm-it's-you popup: it says Confirmed, or Not confirmed with the reason.",
    ),
  },
  async ({ page }) => {
    await step(
      "Open the confirmation page after a cancelled sign-in",
      async () => {
        await page.goto("/sso/confirmed?sso_error=cancelled");
      },
    );
    await step("It says the sign-in was cancelled", async () => {
      await expect(
        page.getByRole("heading", { name: "Not confirmed" }),
      ).toBeVisible();
      await expect(
        page.getByText("Sign-in was cancelled at the identity provider."),
      ).toBeVisible();
    });
    await step("Open the confirmation page after a good sign-in", async () => {
      await page.goto("/sso/confirmed");
    });
    await step("It says Confirmed", async () => {
      await expect(
        page.getByRole("heading", { name: "Confirmed", exact: true }),
      ).toBeVisible();
    });
  },
);
