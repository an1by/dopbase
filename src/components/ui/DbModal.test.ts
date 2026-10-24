/* eslint-disable vue/one-component-per-file */
import { createApp, h, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import DbModal from "./DbModal.vue";
import { modalsSuspended } from "~/composable/modal-suspension";

let app: ReturnType<typeof createApp> | null = null;

function mountModals(onPageClose = vi.fn()) {
  const pageOpen = ref(true);
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp({
    render: () => [
      h(DbModal, { open: true, title: "Session expired", layer: "session" }),
      h(DbModal, { open: true, title: "Confirm your password", layer: "auth" }),
      h(DbModal, {
        open: pageOpen.value,
        title: "Update secret",
        onClose: onPageClose,
      }),
    ],
  });
  app.mount(host);
  return { onPageClose, pageOpen };
}

function overlay(title: string): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>(`[aria-label="${title}"]`)
      ?.parentElement ?? null
  );
}

afterEach(() => {
  app?.unmount();
  app = null;
  modalsSuspended.value = false;
  document.body.innerHTML = "";
  document.body.style.overflow = "";
});

describe("DbModal sizes", () => {
  it("offers an extra-wide size for table dialogs", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    app = createApp({
      render: () => h(DbModal, { open: true, title: "History", size: "xl" }),
    });
    app.mount(host);
    await nextTick();
    expect(
      document.querySelector('[aria-label="History"]')?.className,
    ).toContain("max-w-4xl");
  });
});

describe("DbModal layers", () => {
  it("stacks by layer, whatever order the dialogs mounted in", async () => {
    mountModals();
    await nextTick();
    expect(overlay("Update secret")?.className).toContain("z-50");
    expect(overlay("Confirm your password")?.className).toContain("z-[60]");
    expect(overlay("Session expired")?.className).toContain("z-[70]");
  });

  it("hides and closes everything but the session dialog once the session expires", async () => {
    const { onPageClose } = mountModals();
    await nextTick();

    modalsSuspended.value = true;
    await nextTick();

    expect(onPageClose).toHaveBeenCalledTimes(1);
    expect(overlay("Update secret")).toBeNull();
    expect(overlay("Confirm your password")).toBeNull();
    expect(overlay("Session expired")).not.toBeNull();
    expect(document.body.style.overflow).toBe("hidden");
  });
});
