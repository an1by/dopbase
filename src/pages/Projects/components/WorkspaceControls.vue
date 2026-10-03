<script setup lang="ts">
import { computed, ref } from "vue";
import type { ProjectsController } from "../Projects.controller";
import { DbButton, DbConfirmDialog, DbSelect } from "~/components/ui";
import DirectoryDialog from "./DirectoryDialog.vue";
const props = defineProps<{ controller: ProjectsController }>();
const options = computed(() => [{ value: "", label: "Unassigned" }, ...(props.controller.workspaces?.value ?? []).map(item => ({ value: item.id, label: item.name }))]);
const dialog = ref<"create" | "edit" | null>(null);
const deleting = ref(false); const busy = ref(false); const error = ref<string | null>(null);
async function remove(): Promise<void> {
  const workspace = props.controller.workspace.value; if (!workspace) return;
  busy.value = true; error.value = null;
  try { await props.controller.deleteWorkspace(workspace.id); deleting.value = false; }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "Could not delete workspace."; }
  finally { busy.value = false; }
}
</script>
<template>
  <div class="border-b border-line px-3 py-3">
    <DbSelect label="Workspace" :model-value="controller.workspaceId?.value ?? ''" :options="options" @update:model-value="controller.selectWorkspace" />
    <div class="mt-2 flex flex-wrap gap-1">
      <DbButton size="sm" @click="dialog = 'create'">New</DbButton>
      <DbButton v-if="controller.workspace?.value" size="sm" @click="dialog = 'edit'">Settings</DbButton>
      <DbButton v-if="controller.workspace?.value" size="sm" @click="deleting = true">Delete</DbButton>
    </div>
    <p v-if="controller.workspace?.value" class="mt-2 break-all font-mono text-xs text-ink-faint">{{ controller.workspace.value.rootPath }}</p>
    <p v-if="controller.workspacesError?.value" class="mt-2 text-xs text-crit">{{ controller.workspacesError.value }}</p>
  </div>
  <DirectoryDialog :open="dialog !== null" kind="workspace" :title="dialog === 'edit' ? 'Workspace settings' : 'New workspace'" :initial-name="dialog === 'edit' ? controller.workspace.value?.name : ''" :initial-path="dialog === 'edit' ? controller.workspace.value?.rootPath : ''" :action="(name, rootPath) => dialog === 'edit' && controller.workspace.value ? controller.updateWorkspace(controller.workspace.value.id, { name, rootPath }) : controller.createWorkspace({ name, rootPath })" @close="dialog = null" />
  <DbConfirmDialog :open="deleting" title="Delete workspace" description="Only an empty workspace can be deleted. Move its projects to another workspace first." :confirm-word="controller.workspace?.value?.name" :loading="busy" :error="error" @confirm="remove" @close="deleting = false" />
</template>
