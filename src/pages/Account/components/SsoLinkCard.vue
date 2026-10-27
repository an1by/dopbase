<script setup lang="ts">
import { useSsoLinkCardController } from "./SsoLinkCard.controller";
import { DbAlert, DbBadge, DbButton } from "~/components/ui";
import { KeyIcon } from "~/assets/icons";
import { formatDateTime } from "~/utils/format";

const {
  identity,
  visible,
  linking,
  unlinking,
  canUnlink,
  notice,
  error,
  link,
  unlink,
} = useSsoLinkCardController();
</script>

<template>
  <section
    v-if="visible && identity"
    class="rounded-card border border-line bg-panel p-5 shadow-xs"
    aria-labelledby="sso-heading"
    data-testid="sso-link-card">
    <div class="flex items-center gap-2">
      <KeyIcon class="h-4 w-4 text-ink-muted" />
      <h2 id="sso-heading" class="text-sm font-semibold text-ink-strong">
        Single sign-on
      </h2>
      <DbBadge :tone="identity.linked ? 'ok' : 'neutral'">
        {{ identity.linked ? "Linked" : "Not linked" }}
      </DbBadge>
    </div>
    <DbAlert v-if="notice" tone="success" class="mt-3">{{ notice }}</DbAlert>
    <DbAlert v-if="error" class="mt-3">{{ error }}</DbAlert>
    <template v-if="identity.linked">
      <p class="mt-2 text-xs leading-relaxed text-ink-muted">
        Linked to {{ identity.providerName }}
        <template v-if="identity.emailAtLink"
          >as {{ identity.emailAtLink }}</template
        >
        <template v-if="identity.linkedAt">
          on {{ formatDateTime(identity.linkedAt) }}</template
        >.
      </p>
      <DbButton
        v-if="canUnlink"
        class="mt-3"
        size="sm"
        variant="secondary"
        :loading="unlinking"
        data-testid="sso-unlink"
        @click="unlink">
        Unlink
      </DbButton>
    </template>
    <template v-else>
      <p class="mt-2 text-xs leading-relaxed text-ink-muted">
        Link your {{ identity.providerName }} identity to sign in with it next
        time.
      </p>
      <DbButton class="mt-3" size="sm" :loading="linking" @click="link">
        Link {{ identity.providerName }}
      </DbButton>
    </template>
  </section>
</template>
