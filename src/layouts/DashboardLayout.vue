<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useAuthStore } from "~/stores/auth.store";
import {
  ArchiveIcon,
  AlertTriangleIcon,
  DopbaseIcon,
  FolderIcon,
  HistoryIcon,
  ServerIcon,
  UserIcon,
  UsersIcon,
  LogOutIcon,
} from "~/assets/icons";
import { DbButton, DbModal, DbSpinner } from "~/components/ui";
import ReauthModal from "~/components/app/ReauthModal.vue";
import { useDashboardLayoutController } from "./DashboardLayout.controller";

/**
 * DashboardLayout — the authenticated app shell.
 *
 * A fixed sidebar rail with primary navigation plus the account footer
 * (email + logout), and a content area rendered from the default slot.
 * The global reauthentication dialog lives here so every screen inherits
 * it.
 */
const route = useRoute();
const auth = useAuthStore();
const { email, sessionExpired, loggingOut, logout, signInAgain } =
  useDashboardLayoutController();

const navItems = [
  {
    name: "users",
    label: "Users",
    icon: UsersIcon,
    match: (r: string) => r.startsWith("/users"),
  },
  {
    name: "projects",
    label: "Projects",
    icon: FolderIcon,
    match: (r: string) => r.startsWith("/projects"),
  },
  {
    name: "backups",
    label: "Backups",
    icon: ArchiveIcon,
    match: (r: string) => r.startsWith("/backups"),
  },
  {
    name: "audit",
    label: "Audit",
    icon: HistoryIcon,
    match: (r: string) => r.startsWith("/audit"),
  },
  {
    name: "instance",
    label: "Instance",
    icon: ServerIcon,
    match: (r: string) => r.startsWith("/instance"),
  },
  {
    name: "account",
    label: "Account",
    icon: UserIcon,
    match: (r: string) => r.startsWith("/account"),
  },
] as const;

const isActive = (item: (typeof navItems)[number]): boolean =>
  item.match(route.path);
const visibleNavItems = computed(() =>
  navItems.filter((item) =>
    item.name === "backups" || item.name === "users" || item.name === "audit"
      ? auth.isAdmin
      : true,
  ),
);
const consoleLabel = computed(() =>
  auth.session?.role === "member" ? "member console" : "admin console",
);
</script>

<template>
  <div class="flex min-h-svh">
    <aside
      class="sticky top-0 hidden h-svh w-16 shrink-0 flex-col border-r border-line bg-panel md:flex min-[1120px]:w-60"
      aria-label="Main navigation">
      <!-- Brand -->
      <div
        class="flex h-[4.75rem] min-h-[4.75rem] shrink-0 items-center justify-center gap-2.5 border-b border-line-soft px-2 py-4 min-[1120px]:justify-start min-[1120px]:px-5">
        <div
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-accent/40 bg-accent-soft text-accent-strong"
          :title="`Dopbase ${consoleLabel}`">
          <DopbaseIcon class="h-5 w-5" />
        </div>
        <div class="hidden min-w-0 leading-tight min-[1120px]:block">
          <p class="font-mono text-sm font-semibold text-ink-strong">Dopbase</p>
          <p class="text-xs text-ink-muted">{{ consoleLabel }}</p>
        </div>
      </div>

      <!-- Primary navigation -->
      <nav class="flex flex-col gap-1 px-2 py-4 min-[1120px]:px-3">
        <RouterLink
          v-for="item in visibleNavItems"
          :key="item.name"
          :to="{ name: item.name }"
          class="flex items-center justify-center gap-2.5 rounded-control px-2 py-2 text-sm transition-colors min-[1120px]:justify-start min-[1120px]:px-3"
          :class="
            isActive(item)
              ? 'bg-accent-soft text-ink-strong'
              : 'text-ink-muted hover:bg-raised hover:text-ink-strong'
          "
          :aria-current="isActive(item) ? 'page' : undefined"
          :title="item.label"
          :aria-label="item.label">
          <component :is="item.icon" class="h-4 w-4 shrink-0" />
          <span class="hidden min-[1120px]:inline">{{ item.label }}</span>
        </RouterLink>
      </nav>

      <!-- Account footer -->
      <div
        class="mt-auto border-t border-line-soft px-2 py-3.5 min-[1120px]:px-4">
        <div
          class="flex items-center justify-center gap-2 min-[1120px]:justify-between">
          <div class="hidden min-w-0 min-[1120px]:block">
            <p class="text-xs uppercase tracking-wide text-ink-faint">
              signed in as
            </p>
            <p class="truncate font-mono text-xs text-ink-strong">
              {{ email }}
            </p>
          </div>
          <button
            type="button"
            class="cursor-pointer rounded-control bg-raised p-1.5 text-ink-muted transition-colors hover:bg-crit/15 hover:text-crit disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="loggingOut"
            :aria-label="loggingOut ? 'Logging out...' : 'Log out'"
            :title="loggingOut ? 'Logging out...' : 'Log out'"
            data-testid="logout-button"
            @click="logout">
            <DbSpinner v-if="loggingOut" class="h-4 w-4 text-ink-muted" />
            <LogOutIcon v-else class="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>

    <nav
      class="fixed inset-x-0 bottom-0 z-50 flex items-center justify-around border-t border-line-soft bg-panel px-2 py-2 md:hidden"
      aria-label="Primary">
      <RouterLink
        v-for="item in visibleNavItems"
        :key="item.name"
        :to="{ name: item.name }"
        class="flex flex-col items-center gap-0.5 rounded-control px-3 py-1.5 text-[10px] uppercase tracking-wide transition-colors"
        :class="
          isActive(item)
            ? 'text-accent-strong'
            : 'text-ink-muted hover:text-ink-strong'
        "
        :aria-current="isActive(item) ? 'page' : undefined">
        <component :is="item.icon" class="h-5 w-5" />
        <span>{{ item.label }}</span>
      </RouterLink>
    </nav>

    <main class="min-w-0 flex-1 pb-[4.5rem] md:pb-0">
      <slot />
    </main>

    <ReauthModal />

    <DbModal
      :open="sessionExpired"
      title="Session expired"
      size="sm"
      persistent
      priority>
      <div class="flex flex-col gap-4">
        <div class="flex items-start gap-3">
          <div
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-warn/30 bg-warn/10 text-warn">
            <AlertTriangleIcon class="h-4 w-4" />
          </div>
          <p class="text-sm text-ink">
            Your session has expired. Sign in again to continue.
          </p>
        </div>
        <div class="flex justify-end">
          <DbButton variant="primary" @click="signInAgain">
            Sign in again
          </DbButton>
        </div>
      </div>
    </DbModal>
  </div>
</template>
