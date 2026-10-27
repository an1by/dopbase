/* eslint-disable vue/one-component-per-file */
import { createApp, defineComponent, h, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

const { controller } = await vi.hoisted(async () => {
  const { ref } = await import("vue");
  return {
    controller: {
      secrets: ref([]),
      loading: ref(false),
      loadError: ref(null),
      actionError: ref(null),
      revealedKey: ref(null),
      revealedValue: ref(null),
      revealCountdown: ref(0),
      editorContent: ref(""),
      editorLoading: ref(false),
      editorLoadError: ref(null),
      editorAwaitingReauth: ref(false),
      editorSaving: ref(false),
      editorError: ref(null),
      editorDiff: ref(null),
      editorIssues: ref([]),
      editorDirty: ref(false),
      editorCanSave: ref(false),
      hideRevealed: vi.fn(),
      reveal: vi.fn(),
      openEditor: vi.fn(),
      closeEditor: vi.fn(),
      saveDraft: vi.fn(),
      applyDraft: vi.fn(),
      discardDraft: vi.fn(),
      backToEditing: vi.fn(),
      reload: vi.fn(),
      setSecret: vi.fn(async () => undefined),
      deleteSecret: vi.fn(async () => undefined),
    },
  };
});

vi.mock("./SecretsPanel.controller", () => ({
  useSecretsPanelController: () => controller,
}));
vi.mock("vue-router", () => ({
  useRoute: () => ({ name: "environment", query: {}, params: {} }),
}));
vi.mock("./EnvFileEditor.vue", () => ({
  default: defineComponent({ render: () => null }),
}));
vi.mock("./ImportSecretsDialog.vue", () => ({
  default: defineComponent({ render: () => null }),
}));
vi.mock("./ExportSecretsDialog.vue", () => ({
  default: defineComponent({ render: () => null }),
}));
const history = vi.hoisted(() => ({ key: null as string | null }));
vi.mock("./SecretHistoryDialog.vue", async () => {
  const { defineComponent: define } = await import("vue");
  return {
    default: define({
      props: { secretKey: { type: String, default: null } },
      setup(props) {
        return () => {
          history.key = props.secretKey;
          return null;
        };
      },
    }),
  };
});

import SecretsPanel from "./SecretsPanel.vue";

let app: ReturnType<typeof createApp> | null = null;

function mountPanel() {
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp({
    render: () =>
      h(SecretsPanel, {
        environmentId: "env_1",
        environmentName: "production",
        projectName: "payments",
      }),
  });
  app.mount(host);
  const add = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Add secret",
  );
  add?.click();
  return nextTick();
}

function inputValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  controller.setSecret.mockClear();
});

describe("SecretsPanel create dialog", () => {
  it("requires a value unless empty value is selected", async () => {
    await mountPanel();
    inputValue(
      document.querySelector<HTMLInputElement>('input[name="key"]')!,
      "EMPTY_OK",
    );

    document.querySelector<HTMLFormElement>("form")?.requestSubmit();
    await nextTick();

    expect(controller.setSecret).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Enter a value or select Use empty value.",
    );
  });

  it("disables the field for an empty value and restores an earlier draft", async () => {
    await mountPanel();
    const key = document.querySelector<HTMLInputElement>('input[name="key"]')!;
    const value = document.querySelector<HTMLTextAreaElement>(
      'textarea[name="value"]',
    )!;
    const checkbox = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    inputValue(key, "OPTIONAL_VALUE");
    inputValue(value, "draft-secret");

    checkbox.click();
    await nextTick();
    expect(value.disabled).toBe(true);
    expect(value.value).toBe("");

    checkbox.click();
    await nextTick();
    expect(value.disabled).toBe(false);
    expect(value.value).toBe("draft-secret");

    checkbox.click();
    await nextTick();
    document.querySelector<HTMLFormElement>("form")?.requestSubmit();
    await nextTick();

    expect(controller.setSecret).toHaveBeenCalledWith("OPTIONAL_VALUE", "");
  });

  it("keeps whitespace secret values unchanged", async () => {
    await mountPanel();
    inputValue(
      document.querySelector<HTMLInputElement>('input[name="key"]')!,
      "SPACES",
    );
    inputValue(
      document.querySelector<HTMLTextAreaElement>('textarea[name="value"]')!,
      "   ",
    );

    document.querySelector<HTMLFormElement>("form")?.requestSubmit();
    await nextTick();

    expect(controller.setSecret).toHaveBeenCalledWith("SPACES", "   ");
  });
});

describe("SecretsPanel history", () => {
  it("opens the history of a row from its History button", async () => {
    controller.secrets.value = [
      {
        key: "API_KEY",
        version: 3,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-23T00:00:00Z",
      },
    ] as never;
    await mountPanel();
    expect(history.key).toBeNull();
    document
      .querySelector<HTMLButtonElement>('button[aria-label="History API_KEY"]')!
      .click();
    await nextTick();
    expect(history.key).toBe("API_KEY");
    controller.secrets.value = [];
  });
});
