import { tempDir } from "../harness/helpers.ts";
import {
  ROOT_EMAIL,
  about,
  expect,
  step,
  test,
  useServer,
  type App,
} from "../harness/index.ts";
import type { CliRun } from "../harness/cli.ts";
import { startBrowserLogin } from "../harness/server.ts";
import { confirmPasswordWhenAsked } from "./support.ts";

const app = useServer();

type PendingLogin = { run: CliRun; url: string; code: string };

/**
 * Starts `dopbase login --browser` in a fresh client dir and waits until it
 * prints the approval link and code, the way a person reads them off the
 * terminal. The CLI keeps waiting for the browser after that.
 */
async function startCliLogin(app: App): Promise<PendingLogin> {
  const dir = await tempDir(app, "client-approve");
  const login = startBrowserLogin((run) =>
    app.cliRaw(["login", "--browser"], {
      ...run,
      env: { ...app.server.cliEnv, DOPBASE_DATA_DIR: dir },
      timeoutMs: 45_000,
    }),
  );
  return { run: login.run, ...(await login.prompt) };
}

test(
  "approve a pending CLI login",
  {
    tag: "@auth",
    annotation: about(
      "dopbase login --browser shows a code; the approval page shows the same code, the account, the machine, client and address that asked and when the request expires, and Approve signs the terminal in.",
    ),
  },
  async ({ page }) => {
    await app.signIn(page);
    await confirmPasswordWhenAsked(page);
    const login = await startCliLogin(app);

    await step("Open the link the terminal printed", async () => {
      await page.goto(login.url);
    });
    await step("The page shows the terminal's code", async () => {
      await expect(page).toHaveURL(/\/cli\/approve/);
      await expect(page.getByTestId("cli-review-code")).toHaveAccessibleName(
        new RegExp(`^Code ${login.code.split("").join("-?")}$`, "i"),
      );
      await expect(page.getByText(`Signs in as ${ROOT_EMAIL}`)).toBeVisible();
    });
    await step(
      "It says which machine, client and address asked, and when it expires",
      async () => {
        const row = (label: string) =>
          page
            .locator("dt", { hasText: label })
            .locator("xpath=following-sibling::dd");
        await expect(row("Machine")).not.toHaveText("Not reported");
        await expect(row("Machine")).not.toHaveText("");
        await expect(page.getByTestId("cli-client")).toContainText(/dopbase/i);
        await expect(row("From")).toHaveText("127.0.0.1");
        await expect(row("Requested")).toContainText(/Expires in /);
      },
    );
    await step("Click Approve", async () => {
      await page.getByRole("button", { name: /^Approve/ }).click();
    });
    await step("The terminal is signed in", async () => {
      await expect(
        page.getByRole("heading", { name: /is signed in$/ }),
      ).toBeVisible();
      await expect(page.getByText(`Signed in as ${ROOT_EMAIL}`)).toBeVisible();
      const result = await login.run;
      expect(result.code, result.stderr).toBe(0);
    });
  },
);

test(
  "deny a pending CLI login",
  {
    tag: "@auth",
    annotation: about(
      "Deny on the approval page refuses the request, and dopbase login --browser fails without signing in. The denied page offers another code or Go back, which opens Projects.",
    ),
  },
  async ({ page }) => {
    await app.signIn(page);
    const login = await startCliLogin(app);

    await step("Open the link the terminal printed", async () => {
      await page.goto(login.url);
      await expect(page.getByText(`Signs in as ${ROOT_EMAIL}`)).toBeVisible();
    });
    await step("Click Deny", async () => {
      await page.getByRole("button", { name: "Deny" }).click();
    });
    await step("The request is denied", async () => {
      await expect(
        page.getByRole("heading", { name: "Request denied" }),
      ).toBeVisible();
    });
    await step("dopbase login --browser fails", async () => {
      const result = await login.run;
      expect(result.code).not.toBe(0);
    });
    await step("The page offers another code or a way back", async () => {
      await expect(
        page.getByRole("button", { name: "Enter another code" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Go back" }).click();
      await expect(page).toHaveURL(/\/projects$/);
    });
  },
);
