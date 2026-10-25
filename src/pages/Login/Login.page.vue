<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRoute } from "vue-router";
import { useLoginController } from "./Login.controller";
import { AuthLayout } from "~/layouts";
import {
  DbAlert,
  DbButton,
  DbCode,
  DbInput,
  DbSkeleton,
} from "~/components/ui";
import { TerminalIcon, InfoIcon, KeyIcon } from "~/assets/icons";

const {
  email,
  password,
  fieldErrors,
  formError,
  submitting,
  submit,
  ssoName,
  methodsLoaded,
  showPasswordForm,
  ssoHref,
  ssoError,
  loadMethods,
} = useLoginController();
onMounted(loadMethods);
const route = useRoute();
const notice = computed(() => {
  if (route.query.notice === "password-changed") {
    return "Your password was changed. Sign in with the new password.";
  }
  if (route.query.notice === "backup-restored") {
    return "Backup restored successfully. Sign in with an administrator account from the backup.";
  }
  if (route.query.notice === "cli-approve") {
    return "Sign in to approve the request from your terminal. You'll go straight back to it.";
  }
  return null;
});
</script>

<template>
  <AuthLayout>
    <div class="w-full max-w-sm">
      <p class="mb-1 font-mono text-xs text-ink-faint">$ dopbase login</p>
      <h1 class="text-xl font-semibold">Sign in</h1>
      <p class="mt-1 text-sm text-ink-muted">
        {{
          ssoName && !showPasswordForm
            ? `Use your ${ssoName} account to continue.`
            : "Sign in to your Dopbase account."
        }}
      </p>

      <DbAlert v-if="notice" tone="info" class="mt-6">{{ notice }}</DbAlert>

      <!-- Wait for the sign-in options so a hidden form never flashes. -->
      <DbSkeleton
        v-if="!methodsLoaded"
        class="mt-6 h-11"
        data-testid="login-loading" />
      <div v-else-if="ssoName || ssoError" class="mt-6 flex flex-col gap-3">
        <DbAlert v-if="ssoError">{{ ssoError }}</DbAlert>
        <a
          v-if="ssoName"
          :href="ssoHref"
          data-testid="sso-login"
          class="inline-flex h-11 items-center justify-center gap-2 rounded-control px-4 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          :class="
            showPasswordForm
              ? 'border border-line bg-panel text-ink-strong hover:bg-raised'
              : 'bg-accent text-white hover:bg-accent-alt1'
          ">
          <KeyIcon class="h-4 w-4" aria-hidden="true" />
          Sign in with {{ ssoName }}
        </a>
        <p
          v-if="ssoName && showPasswordForm"
          class="flex items-center gap-3 text-xs text-ink-faint before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
          or use your password
        </p>
      </div>

      <form
        v-if="methodsLoaded && showPasswordForm"
        class="mt-6 flex flex-col gap-4"
        novalidate
        data-testid="login-form"
        @submit.prevent="submit">
        <DbInput
          v-model="email"
          label="Email"
          name="email"
          type="email"
          autocomplete="email"
          placeholder="admin@example.com"
          :error="fieldErrors.email" />

        <DbInput
          v-model="password"
          label="Password"
          name="password"
          type="password"
          autocomplete="current-password"
          :error="fieldErrors.password" />

        <DbAlert v-if="formError">{{ formError }}</DbAlert>

        <DbButton variant="primary" type="submit" :loading="submitting">
          Sign in
        </DbButton>
      </form>

      <details class="group mt-6 rounded-control border border-line bg-panel">
        <summary
          class="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm text-ink-muted transition-colors hover:text-ink">
          <InfoIcon class="h-4 w-4 shrink-0" aria-hidden="true" />
          Lost access?
        </summary>
        <div
          class="border-t border-line-soft px-4 py-3 text-xs leading-relaxed text-ink-muted">
          <p>
            Password recovery is an offline operation performed on the server
            host. Stop the server, then run:
          </p>
          <DbCode class="mt-2">dopbase admin reset-password</DbCode>
          <p class="mt-2">
            The command verifies the master key locally. The key is never
            entered in the browser or sent over HTTP.
          </p>
        </div>
      </details>

      <p class="mt-6 flex items-center gap-1.5 text-xs text-ink-muted">
        <TerminalIcon class="h-3.5 w-3.5" />
        Sessions expire after 8 hours of inactivity.
      </p>
    </div>
  </AuthLayout>
</template>
