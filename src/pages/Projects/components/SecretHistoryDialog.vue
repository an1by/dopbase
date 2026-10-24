<script setup lang="ts">
import { computed } from "vue";
import {
  changeLabel,
  useSecretHistoryController,
} from "./SecretHistory.controller";
import {
  DbAlert,
  DbBadge,
  DbButton,
  DbCopyButton,
  DbModal,
  DbSkeleton,
} from "~/components/ui";
import { EyeIcon, EyeOffIcon, HistoryIcon } from "~/assets/icons";
import { formatDateTime, formatRelativeTime } from "~/utils/format";
import type { RollbackSecretResponse, SecretVersion } from "~/services";

/**
 * SecretHistoryDialog — the stored versions of one secret, newest first.
 *
 * Listing shows metadata only. An earlier value appears only after a
 * password check, in a row that hides itself after 30 seconds. Rolling
 * back saves the chosen value as a new version; nothing in the history is
 * changed, so a rollback can itself be rolled back.
 */
const props = defineProps<{
  environmentId: string;
  /** The secret to show. The dialog is open while this is set. */
  secretKey: string | null;
}>();

const emit = defineEmits<{
  close: [];
  "rolled-back": [result: RollbackSecretResponse];
}>();

const environmentIdRef = computed(() => props.environmentId);
const secretKeyRef = computed(() => props.secretKey);
const {
  versions,
  current,
  retainedVersions,
  nextBefore,
  loading,
  loadingMore,
  loadError,
  actionError,
  notice,
  revealedVersion,
  revealedValue,
  revealCountdown,
  rollbackTarget,
  rollingBack,
  rollbackError,
  load,
  loadMore,
  reveal,
  hideRevealed,
  askRollback,
  cancelRollback,
  confirmRollback,
} = useSecretHistoryController(environmentIdRef, secretKeyRef);

function actor(version: SecretVersion): string {
  if (version.actorLabel) return version.actorLabel;
  return version.actorType === "system" ? "-" : version.actorType;
}

async function onConfirmRollback(): Promise<void> {
  const result = await confirmRollback();
  if (result) emit("rolled-back", result);
}

function close(): void {
  if (rollingBack.value) return;
  hideRevealed();
  emit("close");
}
</script>

<template>
  <DbModal
    :open="secretKey !== null"
    title="Secrets history"
    size="xl"
    @close="close">
    <div class="flex flex-col gap-4" data-testid="secret-history">
      <p class="text-xs text-ink-muted">
        <template v-if="current">
          Current version v{{ current.version }}.
        </template>
        <template v-if="retainedVersions">
          The last {{ retainedVersions }} versions keep their value and can be
          restored.
        </template>
      </p>

      <DbAlert v-if="notice" tone="success" data-testid="history-notice">
        {{ notice }}
      </DbAlert>
      <DbAlert v-if="actionError">{{ actionError }}</DbAlert>

      <!-- Rollback confirmation -->
      <div
        v-if="rollbackTarget && current"
        class="flex flex-col gap-3 rounded-card border border-accent/40 bg-accent-soft/40 p-4"
        data-testid="rollback-confirm">
        <p class="text-sm text-ink-strong">
          Save the value from v{{ rollbackTarget.version }} as a new version,
          v{{ current.version + 1 }}?
        </p>
        <p class="text-xs text-ink-muted">
          Nothing in the history changes. Apps get the new value the next time
          they fetch secrets. Running <code class="font-mono">dopbase run</code>
          processes keep the old value until they restart.
        </p>
        <DbAlert v-if="rollbackError">{{ rollbackError }}</DbAlert>
        <div class="flex justify-end gap-2">
          <DbButton
            variant="ghost"
            size="sm"
            :disabled="rollingBack"
            @click="cancelRollback">
            Cancel
          </DbButton>
          <DbButton
            variant="primary"
            size="sm"
            :loading="rollingBack"
            data-testid="rollback-confirm-button"
            @click="onConfirmRollback">
            Roll back to v{{ rollbackTarget.version }}
          </DbButton>
        </div>
      </div>

      <div v-if="loading && !versions" class="flex flex-col gap-2">
        <DbSkeleton v-for="row in 3" :key="row" class="h-9 w-full" />
      </div>

      <DbAlert v-else-if="loadError">
        {{ loadError }}
        <button
          type="button"
          class="ml-1 cursor-pointer underline"
          @click="load()">
          Try again
        </button>
      </DbAlert>

      <div
        v-else-if="versions"
        class="overflow-x-auto rounded-card border border-line">
        <table class="min-w-full text-left text-sm" data-testid="history-table">
          <thead>
            <tr class="border-b border-line">
              <th class="px-3 py-2 text-xs font-medium text-ink-muted">
                Version
              </th>
              <th class="px-3 py-2 text-xs font-medium text-ink-muted">
                Change
              </th>
              <th
                class="hidden px-3 py-2 text-xs font-medium text-ink-muted sm:table-cell">
                By
              </th>
              <th class="px-3 py-2 text-xs font-medium text-ink-muted">
                Saved
              </th>
              <th
                class="px-3 py-2 text-right text-xs font-medium text-ink-muted">
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <template v-for="item in versions" :key="item.version">
              <tr
                class="border-b border-line-soft last:border-b-0"
                :data-testid="`history-row-${item.version}`">
                <td class="whitespace-nowrap px-3 py-2">
                  <span class="flex items-center gap-1.5">
                    <span class="font-mono text-ink-strong">
                      v{{ item.version }}
                    </span>
                    <DbBadge v-if="item.current" tone="accent">current</DbBadge>
                    <DbBadge v-else-if="!item.restorable">expired</DbBadge>
                  </span>
                </td>
                <td class="px-3 py-2 text-ink">
                  {{ changeLabel(item) }}
                  <p class="text-xs text-ink-muted sm:hidden">
                    {{ actor(item) }}
                  </p>
                </td>
                <td
                  class="hidden max-w-48 truncate px-3 py-2 font-mono text-xs text-ink-muted sm:table-cell"
                  :title="actor(item)">
                  {{ actor(item) }}
                </td>
                <td
                  class="whitespace-nowrap px-3 py-2 text-ink-muted"
                  :title="formatDateTime(item.createdAt)">
                  {{ formatRelativeTime(item.createdAt) }}
                </td>
                <td class="px-3 py-2">
                  <div
                    v-if="!item.current && item.restorable"
                    class="flex items-center justify-end gap-1 whitespace-nowrap">
                    <button
                      v-if="revealedVersion !== item.version"
                      type="button"
                      class="cursor-pointer rounded p-1.5 text-ink-muted transition-colors hover:text-ink-strong pointer-coarse:p-2.5"
                      :aria-label="`Reveal v${item.version}`"
                      @click="reveal(item.version)">
                      <EyeIcon class="h-3.5 w-3.5" />
                    </button>
                    <button
                      v-else
                      type="button"
                      class="cursor-pointer rounded p-1.5 text-accent-strong pointer-coarse:p-2.5"
                      :aria-label="`Hide v${item.version}`"
                      @click="hideRevealed()">
                      <EyeOffIcon class="h-3.5 w-3.5" />
                    </button>
                    <DbButton
                      variant="secondary"
                      size="sm"
                      :aria-label="`Roll back to v${item.version}`"
                      :disabled="rollingBack"
                      @click="askRollback(item)">
                      <HistoryIcon class="h-3.5 w-3.5" />
                      <span class="hidden sm:inline">Roll back</span>
                    </DbButton>
                  </div>
                </td>
              </tr>
              <tr
                v-if="revealedVersion === item.version"
                class="border-b border-line-soft bg-accent-soft/40 last:border-b-0">
                <td colspan="5" class="px-3 py-2.5">
                  <div class="flex flex-wrap items-center gap-3">
                    <code
                      class="min-w-0 flex-1 break-all rounded border border-accent/30 bg-canvas px-3 py-2 font-mono text-xs text-accent-strong">
                      {{ revealedValue }}
                    </code>
                    <DbCopyButton
                      v-if="revealedValue"
                      :value="revealedValue"
                      label="Copy" />
                    <DbBadge tone="warn"
                      >hides in {{ revealCountdown }}</DbBadge
                    >
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <div v-if="nextBefore !== null" class="flex justify-center">
        <DbButton
          variant="ghost"
          size="sm"
          :loading="loadingMore"
          @click="loadMore">
          Load older versions
        </DbButton>
      </div>
    </div>
  </DbModal>
</template>
