// Small helpers shared by the Admin UI specs. They wrap the console's own
// building blocks (dialogs, action menus, typed confirmations) so a spec
// reads like the steps a person takes.
import { randomBytes } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import { ROOT_PASSWORD } from "../harness/index.ts";

/** A throwaway password for an account a test adds in the browser. */
export function testPassword(): string {
  return `pw-${randomBytes(12).toString("hex")}`;
}

/**
 * Gives `principal` access on the Give access page. With `who`, the page
 * came from a project and asks who; otherwise it asks which project.
 */
export async function giveAccess(
  page: Page,
  opts: { who?: string; project?: string; level: string },
): Promise<void> {
  if (opts.who) {
    await page.getByRole("button", { name: "Who" }).click();
    await page
      .getByRole("menuitemradio", { name: new RegExp(escape(opts.who)) })
      .click();
  }
  if (opts.project) {
    await page.getByRole("button", { name: "Project", exact: true }).click();
    await page
      .getByRole("menuitemradio", { name: new RegExp(escape(opts.project)) })
      .click();
  }
  await page
    .getByRole("radiogroup", { name: "Level" })
    .getByText(opts.level, { exact: true })
    .click();
  await page.getByRole("button", { name: "Give access" }).click();
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A dialog by its title, e.g. "Add secret". */
export function dialog(page: Page, title: string | RegExp): Locator {
  return page.getByRole("dialog", { name: title });
}

/** The "Confirm your password" dialog that sensitive actions open. */
export function reauthDialog(page: Page): Locator {
  return dialog(page, "Confirm your password");
}

/** Fills the "Confirm your password" dialog and waits for it to close. */
export async function confirmPassword(
  page: Page,
  password = ROOT_PASSWORD,
): Promise<void> {
  const reauth = reauthDialog(page);
  await reauth.getByLabel("Password", { exact: true }).fill(password);
  await reauth.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(reauth).toBeHidden();
}

/**
 * Answers the "Confirm your password" dialog whenever it shows up. A fresh
 * sign-in counts as recent, so most tests never see it; this keeps them
 * working when a step takes long enough for the sign-in to go stale.
 */
export async function confirmPasswordWhenAsked(
  page: Page,
  password = ROOT_PASSWORD,
): Promise<void> {
  await page.addLocatorHandler(reauthDialog(page), () =>
    confirmPassword(page, password),
  );
}

/** Opens the "Actions for …" menu and picks an item. */
export async function chooseAction(
  page: Page,
  menu: string,
  item: string,
): Promise<void> {
  await page.getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

/** Types the confirmation word in a delete or revoke dialog and confirms. */
export async function typeToConfirm(
  confirm: Locator,
  word: string,
  button: string,
): Promise<void> {
  await confirm.getByLabel(`Type "${word}" to confirm`).fill(word);
  await confirm.getByRole("button", { name: button, exact: true }).click();
  await expect(confirm).toBeHidden();
}

/**
 * Ticks or clears a console checkbox. Its native input is visually hidden
 * inside a label, so the click goes to the label, as a person's would.
 */
export async function setCheckbox(
  checkbox: Locator,
  checked: boolean,
): Promise<void> {
  if ((await checkbox.isChecked()) !== checked) {
    await checkbox.locator("xpath=ancestor::label[1]").click();
  }
  await expect(checkbox).toBeChecked({ checked });
}

/** Opens a page from the sidebar, e.g. "Users" or "Audit log". */
export async function openFromSidebar(
  page: Page,
  label: string,
): Promise<void> {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: label, exact: true })
    .click();
}

/** Signs out through the account menu. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
}
