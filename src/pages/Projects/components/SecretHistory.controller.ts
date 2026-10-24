import { computed, onUnmounted, ref, watch } from "vue";
import type { Ref } from "vue";
import * as secretsApi from "~/services/secrets.api";
import type {
  RollbackSecretResponse,
  SecretVersion,
} from "~/services/secrets.api";
import { ApiError } from "~/services/http.client";
import { isAbortError } from "~/services/api-errors";
import { useReauthentication } from "~/composable";
import { useAuthStore } from "~/stores/auth.store";
import { formatCountdown } from "~/utils/format";
import { REVEAL_SECONDS } from "./SecretsPanel.controller";

export const HISTORY_PAGE_SIZE = 25;

/** Human label for what produced a version. */
export function changeLabel(version: SecretVersion): string {
  switch (version.changeType) {
    case "created":
      return "Created";
    case "updated":
      return "Updated";
    case "imported":
      return "Imported";
    case "rolled_back":
      return version.sourceVersion === null
        ? "Rolled back"
        : `Rolled back from v${version.sourceVersion}`;
    case "legacy":
      return "Before history";
  }
}

/**
 * Version history of one secret: paged metadata, a reauth-gated reveal of
 * one earlier value with the same 30-second auto-hide as the table, and
 * rollback.
 *
 * A revealed value lives only in this controller and is dropped when the
 * key or environment changes, when the dialog closes, and on unmount.
 */
export function useSecretHistoryController(
  environmentId: Ref<string>,
  secretKey: Ref<string | null>,
) {
  const versions = ref<SecretVersion[] | null>(null);
  const retainedVersions = ref<number | null>(null);
  const nextBefore = ref<number | null>(null);
  const loading = ref(false);
  const loadingMore = ref(false);
  const loadError = ref<string | null>(null);
  const actionError = ref<string | null>(null);
  const notice = ref<string | null>(null);
  const { runWithReauth } = useReauthentication();
  const auth = useAuthStore();
  let scope = new AbortController();
  let requestVersion = 0;

  const revealedVersion = ref<number | null>(null);
  const revealedValue = ref<string | null>(null);
  const revealSecondsLeft = ref(0);
  let hideTimer: ReturnType<typeof setInterval> | null = null;

  const rollbackTarget = ref<SecretVersion | null>(null);
  const rollingBack = ref(false);
  const rollbackError = ref<string | null>(null);

  const current = computed(
    () => versions.value?.find((version) => version.current) ?? null,
  );
  const revealCountdown = computed(() =>
    formatCountdown(revealSecondsLeft.value),
  );

  function hideRevealed(): void {
    revealedVersion.value = null;
    revealedValue.value = null;
    revealSecondsLeft.value = 0;
    if (hideTimer) {
      clearInterval(hideTimer);
      hideTimer = null;
    }
  }

  function reset(): void {
    scope.abort();
    scope = new AbortController();
    requestVersion += 1;
    hideRevealed();
    versions.value = null;
    retainedVersions.value = null;
    nextBefore.value = null;
    loading.value = false;
    loadingMore.value = false;
    loadError.value = null;
    actionError.value = null;
    notice.value = null;
    rollbackTarget.value = null;
    rollbackError.value = null;
  }

  async function load(): Promise<void> {
    const key = secretKey.value;
    if (!key) return;
    const target = environmentId.value;
    const request = ++requestVersion;
    const signal = scope.signal;
    loading.value = true;
    loadError.value = null;
    try {
      const page = await secretsApi.listSecretVersions(target, key, {
        limit: HISTORY_PAGE_SIZE,
        signal,
      });
      if (request !== requestVersion) return;
      versions.value = page.items;
      nextBefore.value = page.nextBefore;
      retainedVersions.value = page.retainedVersions;
    } catch (cause) {
      if (request !== requestVersion || signal.aborted) return;
      loadError.value = describeError(cause, "Could not load the history.");
      versions.value = null;
    } finally {
      if (request === requestVersion) loading.value = false;
    }
  }

  async function loadMore(): Promise<void> {
    const key = secretKey.value;
    const before = nextBefore.value;
    if (!key || before === null || loadingMore.value) return;
    const target = environmentId.value;
    const request = requestVersion;
    const signal = scope.signal;
    loadingMore.value = true;
    try {
      const page = await secretsApi.listSecretVersions(target, key, {
        before,
        limit: HISTORY_PAGE_SIZE,
        signal,
      });
      if (request !== requestVersion) return;
      versions.value = [...(versions.value ?? []), ...page.items];
      nextBefore.value = page.nextBefore;
    } catch (cause) {
      if (request !== requestVersion || signal.aborted || auth.sessionExpired)
        return;
      actionError.value = describeError(
        cause,
        "Could not load older versions.",
      );
    } finally {
      if (request === requestVersion) loadingMore.value = false;
    }
  }

  watch(
    [environmentId, secretKey],
    () => {
      reset();
      void load();
    },
    { immediate: true },
  );
  onUnmounted(() => {
    scope.abort();
    hideRevealed();
  });

  function describeError(cause: unknown, fallback: string): string {
    if (!(cause instanceof ApiError)) return fallback;
    if (cause.status === 0) return "Cannot reach the Dopbase server.";
    switch (cause.firstCode) {
      case "SECRET_VERSION_CONFLICT":
        return "This secret changed while you were looking. The history is up to date now, so check it and try again.";
      case "SECRET_VERSION_EXPIRED":
        return "That version is past the retention limit, so its value is no longer stored.";
      case "SECRET_VERSION_IS_CURRENT":
        return "That version is already the current value.";
      case "SECRET_NOT_FOUND":
        return "This secret no longer exists.";
      default:
        return fallback;
    }
  }

  async function reveal(version: number): Promise<void> {
    const key = secretKey.value;
    if (!key) return;
    const target = environmentId.value;
    const signal = scope.signal;
    actionError.value = null;
    try {
      await runWithReauth(async () => {
        const revealed = await secretsApi.revealSecretVersion(
          target,
          key,
          version,
        );
        if (signal.aborted) return;
        hideRevealed();
        revealedVersion.value = version;
        revealedValue.value = revealed.value;
        revealSecondsLeft.value = REVEAL_SECONDS;
        hideTimer = setInterval(() => {
          revealSecondsLeft.value -= 1;
          if (revealSecondsLeft.value <= 0) hideRevealed();
        }, 1000);
      }, signal);
    } catch (cause) {
      if (signal.aborted || isAbortError(cause) || auth.sessionExpired) return;
      actionError.value = describeError(
        cause,
        "Could not reveal that version.",
      );
    }
  }

  function askRollback(version: SecretVersion): void {
    rollbackError.value = null;
    notice.value = null;
    rollbackTarget.value = version;
  }

  function cancelRollback(): void {
    if (rollingBack.value) return;
    rollbackTarget.value = null;
    rollbackError.value = null;
  }

  /** Rolls back to the chosen version. Resolves with the result, or null. */
  async function confirmRollback(): Promise<RollbackSecretResponse | null> {
    const key = secretKey.value;
    const chosen = rollbackTarget.value;
    const expected = current.value;
    if (!key || !chosen || !expected) return null;
    const target = environmentId.value;
    const signal = scope.signal;
    rollingBack.value = true;
    rollbackError.value = null;
    let result: RollbackSecretResponse | undefined;
    try {
      await runWithReauth(async () => {
        result = await secretsApi.rollbackSecret(
          target,
          key,
          chosen.version,
          expected.version,
        );
      }, signal);
      if (signal.aborted || result === undefined) return null;
      rollbackTarget.value = null;
      hideRevealed();
      notice.value = `Rolled back to v${result.sourceVersion}. Now at v${result.version}.`;
      await load();
      return result;
    } catch (cause) {
      if (signal.aborted || isAbortError(cause) || auth.sessionExpired)
        return null;
      const conflict =
        cause instanceof ApiError &&
        cause.firstCode === "SECRET_VERSION_CONFLICT";
      rollbackError.value = describeError(cause, "Could not roll back.");
      if (conflict) await load();
      return null;
    } finally {
      rollingBack.value = false;
    }
  }

  return {
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
  };
}
