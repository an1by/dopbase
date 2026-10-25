<script setup lang="ts">
import { presetOptions, useSsoController } from "./Sso.controller";
import type { SsoPreset } from "~/services/sso.api";
import { DashboardLayout } from "~/layouts";
import {
  DbAlert,
  DbBadge,
  DbButton,
  DbCode,
  DbConfirmDialog,
  DbCopyButton,
  DbInput,
  DbSelect,
  DbSkeleton,
  DbSwitch,
} from "~/components/ui";
import { AlertTriangleIcon } from "~/assets/icons";
import { formatDateTime } from "~/utils/format";

/**
 * Single sign-on — root configures one OpenID Connect provider, proves it
 * with a test sign-in, then turns it on for everyone.
 */
const {
  settings,
  provider,
  status,
  loading,
  loadError,
  preset,
  displayName,
  issuer,
  clientId,
  clientSecret,
  fieldErrors,
  issuerPlaceholder,
  presetHint,
  blocked,
  saving,
  toggling,
  requiring,
  confirmingRequire,
  hidingForm,
  testing,
  notice,
  actionError,
  confirmingRemove,
  removing,
  removeError,
  choosePreset,
  save,
  testSignIn,
  toggle,
  toggleRequired,
  changeRequired,
  closeRequire,
  setPasswordFormHidden,
  promptRemove,
  closeRemove,
  confirmRemove,
} = useSsoController();

const statusLabel: Record<string, string> = {
  none: "Not set up",
  unverified: "Needs a test sign-in",
  ready: "Ready to turn on",
  enabled: "On",
};
</script>

<template>
  <DashboardLayout>
    <div class="mx-auto max-w-3xl px-4 py-6 sm:px-6 lg:p-8">
      <header class="mb-6">
        <div class="flex items-center gap-2.5">
          <h1 class="text-lg font-semibold text-ink-strong">Single sign-on</h1>
          <DbBadge
            v-if="!loading && settings"
            :tone="
              status === 'enabled'
                ? 'ok'
                : status === 'none'
                  ? 'neutral'
                  : 'warn'
            "
            data-testid="sso-status">
            {{ statusLabel[status] }}
          </DbBadge>
        </div>
        <p class="mt-1 text-sm text-ink-muted">
          Let people sign in with your identity provider. You still create
          accounts on the Users page. The first sign-in matches an account by
          its verified email.
        </p>
      </header>

      <DbSkeleton v-if="loading" class="h-64" />
      <DbAlert v-else-if="loadError">{{ loadError }}</DbAlert>

      <div v-else-if="settings" class="flex flex-col gap-6">
        <!-- An insecure public URL blocks everything below. -->
        <section
          v-if="blocked"
          class="flex gap-3 rounded-card border border-warn/40 bg-warn/10 p-4 sm:p-5"
          data-testid="sso-blocked">
          <AlertTriangleIcon class="mt-0.5 h-5 w-5 shrink-0 text-warn" />
          <div class="flex min-w-0 flex-col gap-2 text-sm text-ink">
            <h2 class="font-semibold text-ink-strong">
              Single sign-on needs an HTTPS public URL
            </h2>
            <p>
              This server's public URL is
              <span class="font-mono text-ink-strong">{{
                settings.publicUrl
              }}</span
              >. Your provider would send sign-in codes back to it over plain
              HTTP, readable on the network, so setup stays locked until the URL
              is HTTPS. Restart the server with it:
            </p>
            <DbCode class="truncate"
              >dopbase server start --public-url
              https://dopbase.example.com</DbCode
            >
            <p class="text-ink-muted">
              You can also set
              <span class="font-mono">DOPBASE_PUBLIC_URL</span> or
              <span class="font-mono">public_url</span> in server.toml.
              <span class="font-mono">http://localhost</span> works for trying
              it out on one machine.
            </p>
          </div>
        </section>

        <DbAlert v-if="notice" tone="success">{{ notice }}</DbAlert>
        <DbAlert v-if="actionError">{{ actionError }}</DbAlert>

        <fieldset
          :disabled="blocked"
          class="flex min-w-0 flex-col gap-6"
          :class="blocked ? 'pointer-events-none opacity-50' : ''">
          <section
            class="rounded-card border border-line bg-panel p-4 shadow-xs sm:p-5">
            <h2 class="text-sm font-semibold text-ink-strong">
              1. Register Dopbase with your provider
            </h2>
            <p class="mt-1 text-sm text-ink-muted">
              Create a web application that uses the authorization code flow and
              has a client secret, then add this redirect URI.
            </p>
            <div class="mt-3 flex items-center gap-2">
              <DbCode class="min-w-0 flex-1 truncate">{{
                settings.redirectUri
              }}</DbCode>
              <DbCopyButton :value="settings.redirectUri" />
            </div>
          </section>

          <form
            class="flex flex-col gap-4 rounded-card border border-line bg-panel p-4 shadow-xs sm:p-5"
            novalidate
            data-testid="sso-form"
            @submit.prevent="save">
            <h2 class="text-sm font-semibold text-ink-strong">
              2. Provider details
            </h2>
            <div class="flex flex-col gap-1.5">
              <DbSelect
                :model-value="preset"
                label="Provider"
                :options="presetOptions"
                :disabled="blocked"
                @update:model-value="choosePreset($event as SsoPreset)" />
              <p class="text-xs text-ink-muted" data-testid="sso-preset-hint">
                {{ presetHint }}
              </p>
            </div>
            <DbInput
              v-model="displayName"
              label="Button label"
              name="displayName"
              hint="Shown on the sign-in page button, after Sign in with."
              :disabled="blocked"
              :error="fieldErrors.displayName" />
            <DbInput
              v-model="issuer"
              label="Issuer URL"
              name="issuer"
              mono
              :placeholder="issuerPlaceholder"
              :disabled="blocked"
              :error="fieldErrors.issuer" />
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <DbInput
                v-model="clientId"
                label="Client ID"
                name="clientId"
                mono
                autocomplete="off"
                :disabled="blocked"
                :error="fieldErrors.clientId" />
              <DbInput
                v-model="clientSecret"
                label="Client secret"
                name="clientSecret"
                type="password"
                autocomplete="new-password"
                :placeholder="provider ? 'Stored. Leave blank to keep it.' : ''"
                :disabled="blocked"
                :error="fieldErrors.clientSecret" />
            </div>
            <p v-if="provider" class="text-xs text-ink-muted">
              Changing the issuer, client ID, or secret turns single sign-on off
              until the next test sign-in. A new issuer also removes every
              linked identity, and people link again by verified email when they
              next sign in.
            </p>
            <div>
              <DbButton
                variant="primary"
                type="submit"
                :loading="saving"
                :disabled="blocked">
                Save
              </DbButton>
            </div>
          </form>

          <section
            v-if="provider"
            class="flex flex-col gap-3 rounded-card border border-line bg-panel p-4 shadow-xs sm:p-5">
            <h2 class="text-sm font-semibold text-ink-strong">
              3. Test, then turn on
            </h2>
            <p class="text-sm text-ink-muted">
              The test sign-in links your root account to your identity at the
              provider. It has to work before anyone else can use single
              sign-on.
            </p>
            <p v-if="provider.verifiedAt" class="text-xs text-ink-muted">
              Last test sign-in {{ formatDateTime(provider.verifiedAt) }}.
              {{ provider.linkedAccounts }} linked
              {{ provider.linkedAccounts === 1 ? "account" : "accounts" }}.
            </p>
            <div
              v-if="provider.passwordlessAccounts > 0"
              class="flex gap-2.5 rounded-control border border-warn/30 bg-warn/10 px-3.5 py-3 text-sm text-ink"
              data-testid="sso-passwordless-warning">
              <AlertTriangleIcon class="mt-0.5 h-4 w-4 shrink-0 text-warn" />
              <p>
                {{ provider.passwordlessAccounts }}
                {{
                  provider.passwordlessAccounts === 1
                    ? "account has"
                    : "accounts have"
                }}
                no password. Turning single sign-on off or removing it locks
                {{ provider.passwordlessAccounts === 1 ? "it" : "them" }} out
                until an administrator sets a password on the Users page.
              </p>
            </div>
            <div class="flex flex-wrap gap-3">
              <DbButton
                :variant="status === 'unverified' ? 'primary' : 'secondary'"
                :loading="testing"
                :disabled="blocked"
                data-testid="sso-test"
                @click="testSignIn">
                Test sign-in
              </DbButton>
              <DbButton
                :variant="status === 'ready' ? 'primary' : 'secondary'"
                :disabled="status === 'unverified' || blocked"
                :loading="toggling"
                data-testid="sso-toggle"
                @click="toggle">
                {{ provider.enabled ? "Turn off" : "Turn on" }}
              </DbButton>
              <DbButton
                variant="danger"
                class="sm:ml-auto"
                :disabled="blocked"
                @click="promptRemove">
                Remove
              </DbButton>
            </div>
          </section>

          <section
            v-if="provider?.enabled"
            class="flex flex-col rounded-card border border-line bg-panel shadow-xs"
            data-testid="sso-options">
            <h2
              class="border-b border-line-soft px-4 py-3 text-sm font-semibold text-ink-strong sm:px-5">
              Sign-in options
            </h2>
            <div
              class="flex items-start justify-between gap-6 border-b border-line-soft px-4 py-4 sm:px-5">
              <div class="flex flex-col gap-1">
                <p class="text-sm font-medium text-ink-strong">
                  Hide the password form
                </p>
                <p class="text-xs text-ink-muted">
                  The sign-in page shows only the {{ provider.displayName }}
                  button. Passwords keep working in the CLI and the API, and
                  root can still reach the form at
                  <span class="font-mono">/login?password</span>.
                </p>
              </div>
              <DbSwitch
                :model-value="provider.hidePasswordForm"
                label="Hide the password form"
                hide-label
                :disabled="hidingForm"
                data-testid="sso-hide-form"
                @update:model-value="setPasswordFormHidden" />
            </div>
            <div
              class="flex items-start justify-between gap-6 px-4 py-4 sm:px-5">
              <div class="flex flex-col gap-1">
                <p class="text-sm font-medium text-ink-strong">
                  Require single sign-on
                </p>
                <p class="text-xs text-ink-muted">
                  Refuse password sign-in everywhere, in the browser and the
                  CLI, for every account except root. Root keeps its password so
                  you can get back in if the provider is down.
                </p>
              </div>
              <DbSwitch
                :model-value="provider.requireSso"
                label="Require single sign-on"
                hide-label
                :disabled="requiring"
                data-testid="sso-require"
                @update:model-value="changeRequired" />
            </div>
          </section>
        </fieldset>
      </div>
    </div>

    <DbConfirmDialog
      :open="confirmingRequire"
      title="Require single sign-on?"
      :description="`Everyone except root is signed out now and signs in again with ${provider?.displayName ?? 'single sign-on'}. Password sign-in stops working for them in the browser and the CLI.`"
      confirm-label="Require single sign-on"
      tone="primary"
      :loading="requiring"
      @confirm="toggleRequired"
      @close="closeRequire" />

    <DbConfirmDialog
      :open="confirmingRemove"
      title="Remove single sign-on?"
      description="Every linked identity is removed. People keep their passwords and sign in with them."
      confirm-label="Remove"
      tone="danger"
      :affected-counts="
        provider
          ? [{ label: 'linked accounts', count: provider.linkedAccounts }]
          : undefined
      "
      :loading="removing"
      :error="removeError"
      @confirm="confirmRemove"
      @close="closeRemove" />
  </DashboardLayout>
</template>
