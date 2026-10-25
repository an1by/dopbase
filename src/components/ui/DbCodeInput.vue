<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";

/**
 * DbCodeInput — one box per character for a short code read off another
 * screen, like the code `dopbase login` prints. Typing moves to the next
 * box, Backspace and the arrow keys move back, and pasting the whole code
 * (with or without its dash, in any case) fills every box. Only characters
 * in `alphabet` are accepted.
 *
 * The model is the bare code without separators, upper case.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** Characters accepted, upper case. */
    alphabet?: string;
    length?: number;
    /** A dash is drawn after every `groupSize` characters. */
    groupSize?: number;
    label?: string;
    error?: string | null;
    disabled?: boolean;
    autofocus?: boolean;
  }>(),
  {
    alphabet: "BCDFGHJKLMNPQRSTVWXZ",
    length: 8,
    groupSize: 4,
    label: "Code",
    error: null,
    disabled: false,
    autofocus: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  /** Fired once every box is filled. */
  complete: [value: string];
}>();

const boxes = ref<HTMLInputElement[]>([]);

const characters = computed(() =>
  Array.from(
    { length: props.length },
    (_, index) => props.modelValue[index] ?? "",
  ),
);

/** Keep only accepted characters, upper-cased, up to `length`. */
function clean(value: string): string {
  return [...value.toUpperCase()]
    .filter((character) => props.alphabet.includes(character))
    .join("")
    .slice(0, props.length);
}

function focusBox(index: number): void {
  const box = boxes.value[Math.max(0, Math.min(index, props.length - 1))];
  box?.focus();
  box?.select();
}

function commit(next: string): void {
  emit("update:modelValue", next);
  if (next.length === props.length) emit("complete", next);
}

function setAt(index: number, character: string): void {
  const current = characters.value.slice();
  current[index] = character;
  // Focus never lands past the first empty box, so there are no gaps.
  commit(clean(current.join("")));
}

function onInput(index: number, event: Event): void {
  const input = event.target as HTMLInputElement;
  const typed = clean(input.value);
  if (typed.length > 1) {
    // Autofill or a mobile keyboard dropped several characters at once.
    fill(index, typed);
    return;
  }
  if (!typed) {
    input.value = characters.value[index] ?? "";
    return;
  }
  setAt(index, typed);
  void nextTick(() => focusBox(index + 1));
}

function fill(start: number, text: string): void {
  const current = characters.value.slice(0, start).join("");
  const next = clean(current + text);
  commit(next);
  void nextTick(() => focusBox(next.length));
}

function onPaste(index: number, event: ClipboardEvent): void {
  const text = event.clipboardData?.getData("text") ?? "";
  event.preventDefault();
  // A pasted whole code replaces everything, wherever the caret was.
  const cleaned = clean(text);
  if (cleaned.length === props.length) {
    commit(cleaned);
    void nextTick(() => focusBox(props.length - 1));
  } else {
    fill(index, cleaned);
  }
}

function onKeydown(index: number, event: KeyboardEvent): void {
  if (event.key === "Backspace") {
    event.preventDefault();
    const value = characters.value;
    if (value[index]) {
      commit(value.slice(0, index).join(""));
    } else if (index > 0) {
      commit(value.slice(0, index - 1).join(""));
      focusBox(index - 1);
    }
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    focusBox(index - 1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    focusBox(Math.min(index + 1, props.modelValue.length));
  }
}

/** Clicking any box lands on the first empty one, so the code stays contiguous. */
function onFocus(index: number): void {
  const firstEmpty = props.modelValue.length;
  if (index > firstEmpty) focusBox(firstEmpty);
  else boxes.value[index]?.select();
}

function setBox(element: unknown, index: number): void {
  if (element instanceof HTMLInputElement) boxes.value[index] = element;
}

onMounted(() => {
  if (props.autofocus) focusBox(props.modelValue.length);
});

defineExpose({ focus: () => focusBox(props.modelValue.length) });
</script>

<template>
  <div class="flex flex-col gap-2">
    <div
      role="group"
      :aria-label="label"
      class="flex items-center justify-center gap-1.5 sm:gap-2">
      <template v-for="(character, index) in characters" :key="index">
        <span
          v-if="index > 0 && index % groupSize === 0"
          aria-hidden="true"
          class="mx-0.5 h-0.5 w-3 rounded-full bg-ink-faint sm:mx-1" />
        <input
          :ref="(element) => setBox(element, index)"
          :value="character"
          :disabled="disabled"
          :aria-label="`${label}, character ${index + 1} of ${length}`"
          :aria-invalid="error ? true : undefined"
          :autocomplete="index === 0 ? 'one-time-code' : 'off'"
          autocapitalize="characters"
          spellcheck="false"
          inputmode="text"
          maxlength="1"
          class="h-12 w-9 rounded-control bg-raised text-center font-mono text-xl font-semibold text-ink-strong caret-accent outline-none transition-colors duration-150 focus:bg-line focus:outline-2 focus:outline-solid focus:outline-accent disabled:opacity-50 sm:h-14 sm:w-11 sm:text-2xl"
          :class="error ? 'bg-crit/15 focus:outline-crit' : ''"
          :data-testid="`code-box-${index}`"
          @input="onInput(index, $event)"
          @paste="onPaste(index, $event)"
          @keydown="onKeydown(index, $event)"
          @focus="onFocus(index)" />
      </template>
    </div>
    <p v-if="error" role="alert" class="text-center text-xs text-crit">
      {{ error }}
    </p>
  </div>
</template>
