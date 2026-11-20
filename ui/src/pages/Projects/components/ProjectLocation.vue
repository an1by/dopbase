<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { DbAlert, DbButton, DbInput } from "~/components/ui";
import { useAuthStore } from "~/stores/auth.store";
import * as workspacesApi from "~/services/workspaces.api";
import { setProjectLocation } from "~/services/projects.api";
import type { Project } from "~/services/projects.api";
import type { Workspace } from "~/services/workspaces.api";

const props = defineProps<{ project: Project | null }>();

const auth = useAuthStore();
const workspaces = ref<Workspace[]>([]);
const workspaceId = ref("");
const relativePath = ref(".");
const error = ref<string | null>(null);
const saving = ref(false);

async function load(): Promise<void> {
  if (!auth.can("projects.create")) return;
  try {
    workspaces.value = await workspacesApi.listWorkspaces();
    workspaceId.value =
      props.project?.workspaceId ?? workspaces.value[0]?.id ?? "";
    relativePath.value = props.project?.relativePath ?? ".";
  } catch {
    error.value = "Could not load workspaces.";
  }
}

async function save(): Promise<void> {
  if (!props.project) return;
  saving.value = true;
  error.value = null;
  try {
    await setProjectLocation(
      props.project.id,
      workspaceId.value || null,
      relativePath.value || ".",
    );
  } catch {
    error.value = "Could not update the project directory.";
  } finally {
    saving.value = false;
  }
}

onMounted(load);
watch(() => props.project?.id, load);
</script>

<template>
  <section
    v-if="auth.can('projects.create')"
    class="rounded-card border border-line bg-panel p-4 sm:p-5">
    <h2 class="text-[15px] font-semibold text-ink-strong">
      Workspace directory
    </h2>
    <p class="mt-0.5 mb-4 text-sm text-ink-muted">
      Places this project inside a workspace so workspace runner tokens can read
      it.
    </p>
    <DbAlert v-if="error" class="mb-3">{{ error }}</DbAlert>
    <form class="flex max-w-md flex-col gap-3" @submit.prevent="save">
      <label class="flex flex-col gap-1 text-sm text-ink-muted">
        Workspace
        <select
          v-model="workspaceId"
          name="workspaceId"
          class="rounded-control border border-line bg-panel px-3 py-2 font-mono text-ink-strong">
          <option v-for="item in workspaces" :key="item.id" :value="item.id">
            {{ item.name }}
          </option>
        </select>
      </label>
      <DbInput
        v-model="relativePath"
        label="Relative path"
        name="relativePath"
        mono />
      <DbButton type="submit" variant="primary" :loading="saving"
        >Save directory</DbButton
      >
    </form>
  </section>
</template>
