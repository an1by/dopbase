import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import ReauthModal from "./ReauthModal.vue";
import {
  requestConfirmation,
  useReauthentication,
} from "~/composable/reauthentication";

vi.mock("~/services/auth.api");

let app: ReturnType<typeof createApp> | null = null;

function mountModal(): void {
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp(ReauthModal);
  app.use(createPinia());
  app.mount(host);
}

function passwordInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[name="password"]');
}

async function type(value: string): Promise<void> {
  const input = passwordInput()!;
  input.value = value;
  input.dispatchEvent(new Event("input"));
  await nextTick();
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

afterEach(() => {
  useReauthentication().dismiss();
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

describe("ReauthModal", () => {
  it("explains why it asks, in the caller's words or the default", async () => {
    mountModal();
    requestConfirmation("Confirm it's you before signing in this terminal.");
    await nextTick();
    expect(document.body.textContent).toContain(
      "before signing in this terminal",
    );

    useReauthentication().dismiss();
    requestConfirmation();
    await nextTick();
    expect(document.body.textContent).toContain(
      "This action exposes secret material",
    );
  });

  it("forgets a typed password when the dialog closes", async () => {
    mountModal();
    requestConfirmation();
    await nextTick();
    await type("typed-but-cancelled");
    expect(button("Confirm")?.disabled).toBe(false);

    button("Cancel")?.click();
    await nextTick();
    requestConfirmation();
    await nextTick();
    expect(passwordInput()?.value).toBe("");
    expect(button("Confirm")?.disabled).toBe(true);
  });
});
