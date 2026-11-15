<script setup lang="ts">
import { useSsoHandoffController } from "./SsoHandoff.controller";
import { FocusLayout } from "~/layouts";
import { DbAlert, DbButton, DbSpinner } from "~/components/ui";

/** SsoHandoff — finishes a single sign-on login started on `/login`. */
const { error } = useSsoHandoffController();
</script>

<template>
  <FocusLayout>
    <div v-if="error" class="flex flex-col gap-5">
      <h1 class="text-2xl font-semibold text-ink-strong">
        Sign-in didn't finish
      </h1>
      <DbAlert>{{ error }}</DbAlert>
      <RouterLink :to="{ name: 'login' }" class="w-full">
        <DbButton variant="primary" size="lg" class="w-full">
          Back to sign in
        </DbButton>
      </RouterLink>
    </div>
    <div
      v-else
      class="flex flex-col items-center gap-3 py-10 text-sm text-ink-muted"
      data-testid="sso-handoff-pending">
      <DbSpinner />
      Finishing sign-in…
    </div>
  </FocusLayout>
</template>
