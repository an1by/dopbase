EnvFileEditor.vue 251L cognitive
// D:/Programming/Allior/devops/dopbase/src/pages/Projects/components/EnvFileEditor.vue
§ block block (L1-L87)
<script setup lang="ts">
import { computed, ref } from "vue";
import { highlightEnvContent, type EnvTokenType } from "~/utils/env-highlight";
import { parseEnvFileLines, type EnvFileIssue } from "~/utils/env-file";

/**
 * EnvFileEditor — a lightweight, dependency-free `.env` editor.
 *
 * A transparent textarea sits on top of a tokenized highlight overlay. Both
 * layers share identical typography and wrapping so they stay aligned. The
 * overlay rows embed the line-number gutter, so wrapped lines keep the
 * gutter aligned. Malformed lines are highlighted and listed below.
 * Presentation-only: content is owned by the parent via v-model.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    issues?: EnvFileIssue[];
    disabled?: boolean;
    ariaLabel?: string;
    placeholder?: string;
    /** Filename shown in the editor tab. */
    filename?: string;
    /** Contextual subtitle (e.g. the environment name) in the tab. */
    subtitle?: string;
    /** Marks the buffer as modified — drives the tab's dirty dot. */
    dirty?: boolean;
    /** When set, highlights this line in every synced editor column. */
    peerActiveLine?: number;
    /** Grow to fill a flex parent instead of using a fixed max height. */
    fillHeight?: boolean;
  }>(),
  {
    issues: () => [],
    disabled: false,
    ariaLabel: "Edit .env content",
    placeholder: "",
    filename: ".env",
    subtitle: "",
    dirty: false,
    fillHeight: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  /** Cmd/Ctrl+S pressed — the parent owns the save flow. */
  save: [];
  /** 1-based line index of the caret — used to sync multi-env editors. */
  "caret-line": [line: number];
}>();

/** Gutter width in `ch` units. The textarea's left padding must match. */
const GUTTER_CH = 6;
const MAX_SHOWN_ISSUES = 8;

const lineTokens = computed(() => highlightEnvContent(props.modelValue));
const errorLines = computed(() => new Set(props.issues.map((i) => i.line)));
const visibleIssues = computed(() => props.issues.slice(0, MAX_SHOWN_ISSUES));
const hiddenIssueCount = computed(() =>
  Math.max(0, props.issues.length - MAX_SHOWN_ISSUES),
);

/** Lines that declare a key — the status bar's key count. */
const keyCount = computed(
  () =>
    lineTokens.value.filter((tokens) =>
      tokens.some((token) => token.type === "key"),
    ).length,
);

const tokenClass: Record<EnvTokenType, string> = {
  plain: "text-ink",
  comment: "text-ink-faint italic",
  export: "text-ink-faint",
  key: "text-accent-strong",
  equals: "text-ink-faint",
  value: "text-ink-strong",
  quote: "text-ok",
  error: "text-crit underline decoration-crit/60 underline-offset-2",
};

/* Caret tracking: mirrors the cursor into the status bar (Ln/Col) and
   drives the active-line highlight, like a real editor. */
const caretLine = ref(1);
const caretCol = ref(1);

§ function activeHighlightLine(line (L88-L91)
function activeHighlightLine(line: number): boolean {
  const peer = props.peerActiveLine;
  return line + 1 === (peer && peer > 0 ? peer : caretLine.value);
}
// ... 1 lines omitted
§ function syncCaret(el (L93-L98)
function syncCaret(el: HTMLTextAreaElement): void {
  const lines = el.value.slice(0, el.selectionStart).split("\n");
  caretLine.value = lines.length;
  caretCol.value = (lines[lines.length - 1]?.length ?? 0) + 1;
  emit("caret-line", caretLine.value);
}
// ... 1 lines omitted
§ function onCaretMove(event (L100-L102)
function onCaretMove(event: Event): void {
  syncCaret(event.target as HTMLTextAreaElement);
}
// ... 3 lines omitted
§ function onInput(event (L106-L110)
function onInput(event: Event): void {
  const el = event.target as HTMLTextAreaElement;
  emit("update:modelValue", el.value);
  syncCaret(el);
}
// ... 1 lines omitted
§ function onKeydown(event (L112-L131)
function onKeydown(event: KeyboardEvent): void {
  // Save shortcut — the universal editor reflex.
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    emit("save");
    return;
  }
  if (event.key !== "Tab" || props.disabled) return;
  event.preventDefault();
  const el = event.target as HTMLTextAreaElement;
  const { selectionStart, selectionEnd } = el;
  const next =
    props.modelValue.slice(0, selectionStart) +
    "  " +
    props.modelValue.slice(selectionEnd);
  emit("update:modelValue", next);
  requestAnimationFrame(() => {
    el.selectionStart = el.selectionEnd = selectionStart + 2;
  });
}
// ... 1 lines omitted
§ function focus (L133-L135)
function focus(): void {
  textarea.value?.focus();
}
7/9 chunks shown (1075 tokens)
[lean-ctx] full source: read "D:/Programming/Allior/devops/dopbase/src/pages/Projects/components/EnvFileEditor.vue" directly (no MCP)  ·  or ctx_read("D:/Programming/Allior/devops/dopbase/src/pages/Projects/components/EnvFileEditor.vue", mode="full")
