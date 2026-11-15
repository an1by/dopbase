import { createApp, h, nextTick, ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import DbCodeInput from "./DbCodeInput.vue";

let app: ReturnType<typeof createApp> | null = null;

function mountInput(initial = "") {
  const value = ref(initial);
  const completed: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp({
    render: () =>
      h(DbCodeInput, {
        modelValue: value.value,
        "onUpdate:modelValue": (next: string) => {
          value.value = next;
        },
        onComplete: (code: string) => completed.push(code),
      }),
  });
  app.mount(host);
  const boxes = () => [...host.querySelectorAll("input")];
  return { host, value, completed, boxes };
}

function type(box: HTMLInputElement, text: string): void {
  box.value = text;
  box.dispatchEvent(new Event("input"));
}

function paste(box: HTMLInputElement, text: string): void {
  const event = new Event("paste", { cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: { getData: () => text },
  });
  box.dispatchEvent(event);
}

function press(box: HTMLInputElement, key: string): void {
  box.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true }));
}

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

describe("DbCodeInput", () => {
  it("draws one box per character with a dash between the halves", () => {
    const { host, boxes } = mountInput();
    expect(boxes()).toHaveLength(8);
    expect(host.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
    expect(boxes()[0]?.getAttribute("aria-label")).toBe(
      "Code, character 1 of 8",
    );
  });

  it("upper-cases typed letters, skips ones the code cannot contain, and advances", async () => {
    const { value, boxes } = mountInput();
    type(boxes()[0]!, "w");
    await nextTick();
    expect(value.value).toBe("W");
    await nextTick();
    expect(document.activeElement).toBe(boxes()[1]);

    // A vowel is never part of a code.
    type(boxes()[1]!, "a");
    await nextTick();
    expect(value.value).toBe("W");
  });

  it("fills every box from a pasted code in any format", async () => {
    const { value, completed, boxes } = mountInput();
    paste(boxes()[3]!, "wdjb-mjht");
    await nextTick();
    expect(value.value).toBe("WDJBMJHT");
    expect(completed).toEqual(["WDJBMJHT"]);
    expect(
      boxes()
        .map((box) => box.value)
        .join(""),
    ).toBe("WDJBMJHT");
  });

  it("moves back and clears with Backspace", async () => {
    const { value, boxes } = mountInput("WDJ");
    await nextTick();
    press(boxes()[3]!, "Backspace");
    await nextTick();
    expect(value.value).toBe("WD");
    expect(document.activeElement).toBe(boxes()[2]);
    press(boxes()[1]!, "Backspace");
    await nextTick();
    expect(value.value).toBe("W");
  });

  it("reports completion once the last box is typed", async () => {
    const { completed, boxes } = mountInput("WDJBMJH");
    await nextTick();
    type(boxes()[7]!, "t");
    await nextTick();
    expect(completed).toEqual(["WDJBMJHT"]);
  });
});
