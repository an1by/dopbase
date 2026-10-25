<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useReauthentication } from "~/composable";
import { useAuthStore } from "~/stores/auth.store";
import { KeyIcon, LockIcon } from "~/assets/icons";
import { DbModal, DbInput, DbButton, DbAlert } from "~/components/ui";

/**
 * ReauthModal — global "confirm it's you" dialog.
 *
 * Mounted once per layout that needs it: `DashboardLayout` and the CLI
 * approval page. It opens whenever an API call answers 403
 * RECENT_AUTHENTICATION_REQUIRED (reveal, export, user changes), or when a
 * page that handles that answer itself calls `requestConfirmation`, and
 * re-runs the parked action after a successful confirmation. Accounts
 * linked to single sign-on can confirm at the provider instead, and
 * accounts without a password can only do that.
 */
const {
  isOpen,
  error,
  reason,
  submitting,
  confirmingWithSso,
  submit,
  confirmWithSso,
  dismiss,
} = useReauthentication();
const auth = useAuthStore();

const password = ref("");
// Until the session says otherwise, assume the password works.
const usesPassword = computed(
  () => auth.session?.passwordConfirmation !== false,
);
const ssoName = computed(() => auth.session?.ssoConfirmation ?? null);
const busy = computed(() => submitting.value || confirmingWithSso.value);

// However the dialog closes, never leave a typed password behind for the
// next time it opens.
watch(isOpen, (open) => {
  if (!open) password.value = "";
});

async function onSubmit(): Promise<void> {
  await submit(password.value);
}
</script>

<template>
  <DbModal
    :open="isOpen"
    :title="usesPassword ? 'Confirm your password' : 'Confirm it\'s you'"
    size="sm"
    persistent
    layer="auth"
    @close="dismiss">
    <form class="flex flex-col gap-4" novalidate @submit.prevent="onSubmit">
      <div class="flex items-start gap-3">
        <div
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-warn/30 bg-warn/10 text-warn">
          <LockIcon class="h-4 w-4" />
        </div>
        <p class="text-sm text-ink">
          <template v-if="reason">{{ reason }}</template>
          <template v-else>
            This action exposes secret material and needs a recent
            {{ usesPassword ? "password confirmation" : "sign-in" }}.
          </template>
        </p>
      </div>

      <DbInput
        v-if="usesPassword"
        v-model="password"
        label="Password"
        type="password"
        autocomplete="current-password"
        name="password"
        required
        autofocus />

      <DbButton
        v-if="ssoName"
        :variant="usesPassword ? 'secondary' : 'primary'"
        :loading="confirmingWithSso"
        :disabled="busy"
        data-testid="reauth-sso"
        @click="confirmWithSso">
        <KeyIcon class="h-3.5 w-3.5" />
        Confirm with {{ ssoName }}
      </DbButton>
      <p v-if="confirmingWithSso" class="text-xs text-ink-muted">
        Finish signing in in the window that opened.
      </p>
      <p v-if="!usesPassword && !ssoName" class="text-sm text-ink-muted">
        This account has no password and no single sign-on link. Ask an
        administrator to set a password for it.
      </p>

      <DbAlert v-if="error">{{ error }}</DbAlert>

      <div class="flex items-center justify-end gap-2">
        <DbButton variant="ghost" :disabled="busy" @click="dismiss">
          Cancel
        </DbButton>
        <DbButton
          v-if="usesPassword"
          variant="primary"
          type="submit"
          :loading="submitting"
          :disabled="password.length === 0 || busy">
          Confirm
        </DbButton>
      </div>
    </form>
  </DbModal>
</template>
