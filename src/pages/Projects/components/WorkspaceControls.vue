<script setup lang="ts">
import { computed, ref } from "vue";
import type { ProjectsController } from "../Projects.controller";
import { DbConfirmDialog, DbModal, DbSelect } from "~/components/ui";
import DirectoryDialog from "./DirectoryDialog.vue";
import WorkspaceTokensPanel from "./WorkspaceTokensPanel.vue";
import { workspaceLabel } from "~/constants/workspaces";
import { KeyIcon, PencilIcon, PlusIcon, TrashIcon } from "~/assets/icons";

const props = defineProps<{ controller: ProjectsController }>();

const options = computed(() =>
  (props.controller.workspaces?.value ?? []).map((item) => ({
    value: item.id,
    label: workspaceLabel(item),
  })),
);

const dialog = ref<"create" | "edit" | null>(null);
const tokensOpen = ref(false);
const deleting = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);

const iconButtonClass =
  "cursor-pointer rounded-control bg-raised p-1 text-ink-muted transition-colors hover:bg-line hover:text-ink-strong disabled:cursor-default disabled:opacity-50";

async function remove(): Promise<void> {
  const workspace = props.controller.workspace.value;
  if (!workspace) return;
  busy.value = true;
  error.value = null;
  try {
    await props.controller.deleteWorkspace(workspace.id);
    deleting.value = false;
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Could not delete workspace.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="shrink-0 border-b border-line-soft">
    <div
      class="flex h-[4.75rem] min-h-[4.75rem] items-center gap-2.5 px-5 py-4"
      data-testid="workspace-toolbar">
      <DbSelect
        compact
        class="min-w-0 flex-1"
        label="Workspace"
        :model-value="controller.workspaceId?.value"
        :options="options"
        @update:model-value="controller.selectWorkspace" />
      <div class="flex shrink-0 items-center gap-1">
        <button
          type="button"
          :class="iconButtonClass"
          aria-label="New workspace"
          data-testid="new-workspace"
          @click="dialog = 'create'">
          <PlusIcon class="h-4 w-4" />
        </button>
        <button
          v-if="controller.workspace?.value"
          type="button"
          :class="iconButtonClass"
          aria-label="Workspace tokens"
          data-testid="workspace-tokens"
          @click="tokensOpen = true">
          <KeyIcon class="h-4 w-4" />
        </button>
        <button
          v-if="controller.workspace?.value"
          type="button"
          :class="iconButtonClass"
          aria-label="Workspace settings"
          @click="dialog = 'edit'">
          <PencilIcon class="h-4 w-4" />
        </button>
        <button
          v-if="controller.workspace?.value"
          type="button"
          :class="iconButtonClass"
          aria-label="Delete workspace"
          @click="deleting = true">
          <TrashIcon class="h-4 w-4" />
        </button>
      </div>
    </div>
    <p
      v-if="controller.workspacesError?.value"
      class="px-4 pb-3 text-xs text-crit md:px-5 md:pb-4 md:pt-0">
      {{ controller.workspacesError.value }}
    </p>
    <p
      v-else-if="controller.workspace?.value"
      class="break-all px-4 pb-3 font-mono text-xs text-ink-faint md:hidden">
      {{ controller.workspace.value.rootPath }}
    </p>
  </div>
  <DirectoryDialog
    :open="dialog !== null"
    kind="workspace"
    :workspace-mode="dialog === 'edit' ? 'edit' : 'create'"
    :title="dialog === 'edit' ? 'Workspace settings' : 'New workspace'"
    :initial-name="dialog === 'edit' ? controller.workspace.value?.name : ''"
    :initial-path="dialog === 'edit' ? controller.workspace.value?.rootPath : ''"
    :action="
      (name, rootPath) =>
        dialog === 'edit' && controller.workspace.value
          ? controller.updateWorkspace(controller.workspace.value.id, {
              name,
              rootPath,
            })
          : controller.createWorkspace({ name })
    "
    @close="dialog = null" />
  <DbModal
    :open="tokensOpen && !!controller.workspace?.value"
    title="Workspace tokens"
    @close="tokensOpen = false">
    <WorkspaceTokensPanel
      v-if="controller.workspace?.value"
      :workspace-id="controller.workspace.value.id" />
  </DbModal>
  <DbConfirmDialog
    :open="deleting"
    title="Delete workspace"
    description="Only an empty workspace can be deleted. Move its projects to another workspace first."
    :confirm-word="controller.workspace?.value?.name"
    :loading="busy"
    :error="error"
    @confirm="remove"
    @close="deleting = false" />
</template>
