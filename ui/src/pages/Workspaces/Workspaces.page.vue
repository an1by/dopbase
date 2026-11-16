<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { DashboardLayout } from "~/layouts";
import PageHeader from "~/components/app/PageHeader.vue";
import { DbAlert, DbButton, DbInput, DbSkeleton } from "~/components/ui";
import { useAuthStore } from "~/stores/auth.store";
import * as workspacesApi from "~/services/workspaces.api";
import * as tokensApi from "~/services/tokens.api";
import type { Workspace } from "~/services/workspaces.api";
import type { WorkspaceToken } from "~/services/tokens.api";

const auth = useAuthStore();
const canManage = computed(() => auth.can("projects.create"));

const workspaces = ref<Workspace[] | null>(null);
const loadError = ref<string | null>(null);
const actionError = ref<string | null>(null);
const selectedId = ref<string | null>(null);
const name = ref("");
const rootPath = ref("/workspace");
const saving = ref(false);
const tokens = ref<WorkspaceToken[]>([]);
const tokenName = ref("");
const plaintext = ref<string | null>(null);

const selected = computed(
  () => workspaces.value?.find((item) => item.id === selectedId.value) ?? null,
);

async function load(): Promise<void> {
  loadError.value = null;
  try {
    workspaces.value = await workspacesApi.listWorkspaces();
    if (!selectedId.value && workspaces.value[0]) {
      selectedId.value = workspaces.value[0].id;
    }
    await loadTokens();
  } catch {
    loadError.value = "Could not load workspaces.";
  }
}

async function loadTokens(): Promise<void> {
  tokens.value = [];
  plaintext.value = null;
  if (!selectedId.value || !canManage.value) return;
  try {
    tokens.value = await tokensApi.listWorkspaceTokens(selectedId.value);
  } catch {
    actionError.value = "Could not load workspace tokens.";
  }
}

async function createWorkspace(): Promise<void> {
  if (!canManage.value) return;
  saving.value = true;
  actionError.value = null;
  try {
    const created = await workspacesApi.createWorkspace({
      name: name.value.trim(),
      rootPath: rootPath.value.trim() || undefined,
    });
    name.value = "";
    selectedId.value = created.id;
    await load();
  } catch {
    actionError.value = "Could not create the workspace.";
  } finally {
    saving.value = false;
  }
}

async function saveSelected(): Promise<void> {
  const current = selected.value;
  if (!current || !canManage.value) return;
  saving.value = true;
  actionError.value = null;
  try {
    await workspacesApi.updateWorkspace(current.id, {
      name: current.name,
      rootPath: current.rootPath,
    });
    await load();
  } catch {
    actionError.value = "Could not update the workspace.";
  } finally {
    saving.value = false;
  }
}

async function removeSelected(): Promise<void> {
  const current = selected.value;
  if (!current || !canManage.value) return;
  saving.value = true;
  actionError.value = null;
  try {
    await workspacesApi.deleteWorkspace(current.id);
    selectedId.value = null;
    await load();
  } catch {
    actionError.value = "Could not delete the workspace. Move its projects first.";
  } finally {
    saving.value = false;
  }
}

async function createToken(): Promise<void> {
  if (!selectedId.value || !canManage.value) return;
  actionError.value = null;
  plaintext.value = null;
  try {
    const created = await tokensApi.createWorkspaceToken(selectedId.value, {
      name: tokenName.value.trim(),
      role: "workspace",
      expiresIn: "90d",
    });
    plaintext.value = created.plaintextToken;
    tokenName.value = "";
    await loadTokens();
  } catch {
    actionError.value = "Could not create the workspace token.";
  }
}

async function revoke(id: string): Promise<void> {
  actionError.value = null;
  try {
    await tokensApi.revokeToken(id);
    await loadTokens();
  } catch {
    actionError.value = "Could not revoke the token.";
  }
}

onMounted(load);
</script>

<template>
  <DashboardLayout>
    <PageHeader
      title="Workspaces"
      description="Directories that group projects and scope dbw_ runner tokens." />
    <DbAlert v-if="loadError">{{ loadError }}</DbAlert>
    <DbAlert v-if="actionError">{{ actionError }}</DbAlert>
    <DbSkeleton v-if="!workspaces && !loadError" class="h-40" />
    <div v-else class="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <ul class="flex flex-col gap-1">
        <li v-for="item in workspaces" :key="item.id">
          <button
            type="button"
            class="w-full rounded-control px-3 py-2 text-left text-sm"
            :class="item.id === selectedId ? 'bg-raised text-ink-strong' : 'text-ink-muted'"
            @click="selectedId = item.id; loadTokens()">
            {{ item.name }}
          </button>
        </li>
      </ul>
      <div class="flex flex-col gap-5">
        <form v-if="canManage" class="flex flex-wrap items-end gap-3" @submit.prevent="createWorkspace">
          <DbInput v-model="name" label="New workspace" name="workspaceName" mono />
          <DbInput v-model="rootPath" label="Root path" name="rootPath" mono />
          <DbButton type="submit" variant="primary" :loading="saving">Create</DbButton>
        </form>
        <form v-if="selected && canManage" class="flex flex-col gap-3" @submit.prevent="saveSelected">
          <DbInput v-model="selected.name" label="Name" name="editName" mono />
          <DbInput v-model="selected.rootPath" label="Root path" name="editRoot" mono />
          <div class="flex gap-2">
            <DbButton type="submit" variant="primary" :loading="saving">Save</DbButton>
            <DbButton type="button" variant="danger" :loading="saving" @click="removeSelected">
              Delete
            </DbButton>
          </div>
        </form>
        <section v-if="selected && canManage">
          <h2 class="mb-2 text-sm font-semibold text-ink-strong">Runner tokens</h2>
          <form class="mb-3 flex items-end gap-2" @submit.prevent="createToken">
            <DbInput v-model="tokenName" label="Token name" name="tokenName" mono />
            <DbButton type="submit">Create token</DbButton>
          </form>
          <p v-if="plaintext" class="mb-3 break-all font-mono text-sm">{{ plaintext }}</p>
          <ul class="flex flex-col gap-1 text-sm">
            <li v-for="token in tokens" :key="token.id" class="flex items-center justify-between gap-3">
              <span class="font-mono">{{ token.name }}</span>
              <DbButton
                v-if="!token.revokedAt"
                type="button"
                variant="danger"
                @click="revoke(token.id)">
                Revoke
              </DbButton>
            </li>
          </ul>
        </section>
      </div>
    </div>
  </DashboardLayout>
</template>
