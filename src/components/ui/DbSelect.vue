<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from "vue";
import { ChevronDownIcon } from "~/assets/icons";

/**
 * DbSelect is a labeled native select. The label sits inside the filled
 * control, and a chevron indicates the menu.
 * Presentation-only.
 */
const props = defineProps<{
  modelValue: string;
  label?: string;
  options: Array<{ label: string; value: string }>;
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const id = useId();
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const open = ref(false);
const active = ref(0);
const position = ref({ left: "0px", top: "0px", width: "0px", maxHeight: "240px" });
const selected = computed(() => props.options.find((item) => item.value === props.modelValue));
let search = "";
let searchTimer: ReturnType<typeof setTimeout> | undefined;
function close(): void { open.value = false; }
async function show(): Promise<void> {
  if (props.disabled || !props.options.length) return;
  const rect = trigger.value?.getBoundingClientRect();
  if (!rect) return;
  const below = window.innerHeight - rect.bottom - 12;
  const height = Math.min(280, Math.max(below, rect.top - 12));
  position.value = {
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8))}px`,
    width: `${Math.min(rect.width, window.innerWidth - 16)}px`,
    top: `${below >= Math.min(180, props.options.length * 36 + 8) ? rect.bottom + 4 : Math.max(8, rect.top - Math.min(height, props.options.length * 36 + 8) - 4)}px`,
    maxHeight: `${height}px`,
  };
  active.value = Math.max(0, props.options.findIndex((item) => item.value === props.modelValue));
  open.value = true;
  await nextTick();
  menu.value?.children[active.value]?.scrollIntoView?.({ block: "nearest" });
}
function choose(index: number): void {
  const item = props.options[index];
  if (!item) return;
  emit("update:modelValue", item.value); close(); trigger.value?.focus();
}
function outside(event: PointerEvent): void {
  if (!trigger.value?.contains(event.target as Node) && !menu.value?.contains(event.target as Node)) close();
}
function scrollOutside(event: Event): void { if (!menu.value?.contains(event.target as Node)) close(); }
function keydown(event: KeyboardEvent): void {
  if (props.disabled) return;
  if (event.key === "Tab") { close(); return; }
  if (event.key === "Escape") { if (open.value) event.stopPropagation(); close(); return; }
  if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) {
    event.preventDefault();
    if (!open.value) { void show(); return; }
    if (event.key === "Enter" || event.key === " ") { choose(active.value); return; }
    active.value = event.key === "Home" ? 0 : event.key === "End" ? props.options.length - 1 : (active.value + (event.key === "ArrowDown" ? 1 : -1) + props.options.length) % props.options.length;
    void nextTick(() => menu.value?.children[active.value]?.scrollIntoView?.({ block: "nearest" }));
  } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
    search += event.key.toLowerCase(); clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { search = ""; }, 600);
    const index = props.options.findIndex((item) => item.label.toLowerCase().startsWith(search));
    if (index >= 0) { if (open.value) active.value = index; else choose(index); }
  }
}
function removeListeners(): void {
  document.removeEventListener("pointerdown", outside);
  window.removeEventListener("resize", close);
  window.removeEventListener("scroll", scrollOutside, true);
}
watch(open, (value) => {
  if (value) {
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scrollOutside, true);
  } else removeListeners();
});
watch(() => props.disabled, (value) => { if (value) close(); });
onUnmounted(() => { removeListeners(); clearTimeout(searchTimer); });
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <button ref="trigger" type="button" :disabled="disabled" role="combobox" aria-haspopup="listbox" :aria-expanded="open" :aria-controls="`${id}-list`" :aria-activedescendant="open ? `${id}-${active}` : undefined" :aria-label="label" class="w-full cursor-pointer rounded-control bg-raised text-left transition-colors hover:bg-line focus-visible:bg-line disabled:cursor-default disabled:opacity-50" @click="open ? close() : show()" @keydown="keydown">
      <span v-if="label" class="block px-3.5 pb-0.5 pt-2 text-xs font-semibold text-ink-muted">{{ label }}</span>
      <span class="flex items-center justify-between gap-3 px-3.5 text-sm text-ink-strong" :class="label ? 'h-9' : 'h-10'">
        <span class="truncate">{{ selected?.label ?? modelValue }}</span>
        <ChevronDownIcon class="h-4 w-4 shrink-0 text-ink-faint transition-transform" :class="open ? 'rotate-180' : ''" />
      </span>
    </button>
    <Teleport to="body">
      <div v-if="open" :id="`${id}-list`" ref="menu" role="listbox" :aria-label="label" :style="position" class="fixed z-[100] overflow-y-auto rounded-control border border-line bg-panel p-1 shadow-2xl">
        <div v-for="(option, index) in options" :id="`${id}-${index}`" :key="option.value" role="option" :aria-selected="option.value === modelValue" class="min-h-9 cursor-pointer rounded px-3 py-1.5 text-sm" :class="index === active ? 'bg-accent-soft text-accent-strong' : 'text-ink hover:bg-raised'" @pointermove="active = index" @mousedown.prevent @click="choose(index)">{{ option.label }}</div>
      </div>
    </Teleport>
  </div>
</template>
