<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { XIcon } from "~/assets/icons";
import { acquireScrollLock, releaseScrollLock } from "~/composable/scroll-lock";

/**
 * DbSheet — a full-height panel that slides in from the left edge. Used
 * where a desktop column (the app sidebar, the project rail) folds away on
 * narrow screens. Renders via Teleport, closes on Escape and backdrop
 * click, and shares the body scroll lock with DbModal.
 */
const props = defineProps<{
  open: boolean;
  title: string;
}>();

const emit = defineEmits<{ close: [] }>();

const panel = ref<HTMLElement | null>(null);

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close");
}

function activate(): void {
  document.addEventListener("keydown", onKeydown);
  acquireScrollLock();
  requestAnimationFrame(() => panel.value?.focus());
}

function deactivate(): void {
  document.removeEventListener("keydown", onKeydown);
  releaseScrollLock();
}

watch(
  () => props.open,
  (open) => (open ? activate() : deactivate()),
);

onMounted(() => {
  if (props.open) activate();
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  if (props.open) releaseScrollLock();
});
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-200 motion-reduce:transition-none [&>[role=dialog]]:transition-transform [&>[role=dialog]]:duration-200 [&>[role=dialog]]:ease-out"
      leave-active-class="transition-opacity duration-150 motion-reduce:transition-none [&>[role=dialog]]:transition-transform [&>[role=dialog]]:duration-150 [&>[role=dialog]]:ease-in"
      enter-from-class="opacity-0 [&>[role=dialog]]:-translate-x-full motion-reduce:[&>[role=dialog]]:translate-x-0"
      leave-to-class="opacity-0 [&>[role=dialog]]:-translate-x-full motion-reduce:[&>[role=dialog]]:translate-x-0">
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex bg-black/60"
        @mousedown.self="emit('close')">
        <div
          ref="panel"
          class="flex h-full w-[min(20rem,85vw)] flex-col border-r border-line bg-panel shadow-2xl focus:outline-none"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
          tabindex="-1">
          <header
            class="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line-soft pl-4 pr-2">
            <h2 class="truncate text-sm font-semibold text-ink-strong">
              {{ title }}
            </h2>
            <button
              type="button"
              class="flex h-11 w-11 cursor-pointer items-center justify-center rounded-control text-ink-muted transition-colors hover:bg-raised hover:text-ink-strong"
              aria-label="Close"
              @click="emit('close')">
              <XIcon class="h-4 w-4" />
            </button>
          </header>
          <div class="flex min-h-0 flex-1 flex-col">
            <slot />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
