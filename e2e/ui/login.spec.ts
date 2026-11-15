import {
  ROOT_EMAIL,
  ROOT_PASSWORD,
  about,
  expect,
  step,
  test,
  useServer,
} from "../harness/index.ts";
import { signOut } from "./support.ts";

const app = useServer();

test(
  "root signs in with a password and signs out",
  {
    tag: "@auth",
    annotation: about(
      "A wrong password shows an error, the right one opens Projects, and Sign out returns to the login page.",
    ),
  },
  async ({ page }) => {
    await step("Open the login page", async () => {
      await page.goto("/login");
      await expect(
        page.getByRole("heading", { name: "Sign in", exact: true }),
      ).toBeVisible();
    });
    await step("Sign in with a wrong password", async () => {
      await page.getByLabel("Email").fill(ROOT_EMAIL);
      await page
        .getByLabel("Password", { exact: true })
        .fill("not-the-password");
      await page.getByRole("button", { name: "Sign in" }).click();
    });
    await step("Email or password is wrong is shown", async () => {
      await expect(page.getByRole("alert")).toContainText(
        "Email or password is wrong.",
      );
      await expect(page).toHaveURL(/\/login$/);
    });
    await step("Sign in with the right password", async () => {
      await page.getByLabel("Password", { exact: true }).fill(ROOT_PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
    });
    await step("Projects is shown, signed in as root", async () => {
      await expect(page).toHaveURL(/\/projects$/);
      await expect(
        page.getByRole("button", { name: "Account menu" }),
      ).toContainText(ROOT_EMAIL);
    });
    await step("Sign out from the account menu", async () => {
      await signOut(page);
    });
    await step("The login page is shown again", async () => {
      await expect(page).toHaveURL(/\/login/);
      await expect(
        page.getByRole("heading", { name: "Sign in", exact: true }),
      ).toBeVisible();
    });
  },
);

test(
  "the sign-in form counts down tries and warns about Caps Lock",
  {
    tag: "@auth",
    annotation: about(
      "Wrong passwords for one email say how many tries are left before a 15-minute pause, and typing with Caps Lock on shows a warning that leaving the field hides.",
    ),
  },
  async ({ page }) => {
    // The limit is counted per email. An email nobody has keeps root clear
    // of it, and the server answers it the same way as a real account.
    const email = `${app.uniq("nobody")}@dopbase.com`;
    await step("Open the login page", async () => {
      await page.goto("/login");
      await page.getByLabel("Email").fill(email);
    });
    const password = page.getByLabel("Password", { exact: true });
    await step("Caps Lock on shows a warning", async () => {
      await password.focus();
      await password.dispatchEvent("keydown", {
        key: "A",
        modifierCapsLock: true,
      });
      await expect(page.getByTestId("caps-lock")).toHaveText("Caps Lock is on");
    });
    await step("Leaving the field hides it", async () => {
      await page.getByLabel("Email").focus();
      await expect(page.getByTestId("caps-lock")).toHaveCount(0);
    });
    await step("The first wrong password gives the plain message", async () => {
      await password.fill("wrong-password-1");
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByTestId("login-error")).toHaveText(
        "Email or password is wrong.",
      );
    });
    await step("The second says 3 more tries, then a pause", async () => {
      await password.fill("wrong-password-2");
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByTestId("login-error")).toContainText(
        "3 more tries, then a 15-minute pause.",
      );
    });
  },
);

test(
  "a signed-out visitor lands on the login page",
  {
    tag: "@auth",
    annotation: about(
      "Opening a signed-in page without a session redirects to /login and comes back after signing in.",
    ),
  },
  async ({ page }) => {
    await step("Open /audit while signed out", async () => {
      await page.goto("/audit");
    });
    await step("The login page is shown", async () => {
      await expect(page).toHaveURL(/\/login\?redirect=\/audit$/);
    });
    await step("Sign in", async () => {
      await page.getByLabel("Email").fill(ROOT_EMAIL);
      await page.getByLabel("Password", { exact: true }).fill(ROOT_PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
    });
    await step("The audit log opens, where the visit started", async () => {
      await expect(page).toHaveURL(/\/audit$/);
    });
  },
);

test(
  "a launch link signs in once",
  {
    tag: "@auth",
    annotation: about(
      "A one-time link from `dopbase admin passcode` signs root in and lands on Projects; opening it again says it was already used.",
    ),
  },
  async ({ page, browser }) => {
    const link = await app.launchLink();
    await step("Open a launch link from dopbase admin passcode", async () => {
      await page.goto(link);
    });
    await step("Projects is shown, signed in", async () => {
      await expect(page).toHaveURL(/\/projects$/);
      await expect(
        page.getByRole("button", { name: "Account menu" }),
      ).toContainText(ROOT_EMAIL);
    });
    const other = await browser.newPage();
    try {
      await step("Open the same link in a fresh browser", async () => {
        await other.goto(`${app.url}${link}`);
      });
      await step("The link is refused as already used", async () => {
        await expect(
          other.getByRole("heading", { name: "This launch link didn't work" }),
        ).toBeVisible();
        await expect(other.getByText("already used")).toBeVisible();
      });
    } finally {
      await other.close();
    }
  },
);

test(
  "login help explains how to reset a password",
  {
    tag: "@auth",
    annotation: about(
      "Forgot password? opens the help page, which names the reset command, and Back to sign in returns.",
    ),
  },
  async ({ page }) => {
    await step("Open the login page", async () => {
      await page.goto("/login");
    });
    await step("Click Forgot password?", async () => {
      await page.getByRole("link", { name: "Forgot password?" }).click();
    });
    await step("The help page names the reset command", async () => {
      await expect(page).toHaveURL(/\/login\/help$/);
      await expect(
        page.getByRole("heading", { name: "Reset your password" }),
      ).toBeVisible();
      await expect(
        page.getByText("dopbase admin reset-password root@dopbase.com"),
      ).toBeVisible();
    });
    await step("Click Back to sign in", async () => {
      await page.getByRole("link", { name: "Back to sign in" }).click();
      await expect(page).toHaveURL(/\/login$/);
    });
  },
);
