<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from "vue";

const props = defineProps<{ alt?: string }>();

const trigger = ref<HTMLButtonElement | null>(null);
const dialog = ref<HTMLDialogElement | null>(null);
const open = ref(false);
const src = ref("");

function readImage(): HTMLImageElement | null {
  return trigger.value?.querySelector("img") ?? null;
}

function lockScroll(locked: boolean): void {
  document.documentElement.classList.toggle("image-viewer-open", locked);
}

function openViewer(): void {
  const image = readImage();
  if (image === null) return;
  src.value = image.currentSrc || image.src;
  open.value = true;
  lockScroll(true);
  void nextTick(() => {
    if (dialog.value && !dialog.value.open) dialog.value.showModal();
  });
}

function closeViewer(): void {
  open.value = false;
  lockScroll(false);
  if (dialog.value?.open) dialog.value.close();
  void nextTick(() => trigger.value?.focus());
}

function handleCancel(event: Event): void {
  event.preventDefault();
  closeViewer();
}

function handleDialogClose(): void {
  if (open.value) closeViewer();
}

onBeforeUnmount(() => {
  if (open.value) lockScroll(false);
});
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="image-viewer"
    :aria-label="props.alt ? `View full size: ${props.alt}` : 'View full size'"
    @click="openViewer">
    <slot />
  </button>

  <Teleport to="body">
    <dialog
      v-if="open"
      ref="dialog"
      class="image-viewer__dialog"
      :aria-label="props.alt || 'Full-size image'"
      @cancel="handleCancel"
      @close="handleDialogClose"
      @click="closeViewer">
      <figure class="image-viewer__figure">
        <img :src="src" :alt="props.alt ?? ''" />
        <figcaption v-if="props.alt" @click.stop>{{ props.alt }}</figcaption>
      </figure>
      <button
        type="button"
        class="image-viewer__close"
        aria-label="Close"
        @click.stop="closeViewer">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </dialog>
  </Teleport>
</template>
