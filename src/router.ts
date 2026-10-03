import { createRouter, createWebHistory } from "vue-router";
import { installRouterGuards } from "./router.guards";

/**
 * Route table for the Admin UI.
 *
 * Project selection lives in the URL as
 * `/projects/:workspaceSlug/:projectRef/:environmentName`, with `all` as the
 * environment segment for the multi-environment overview. Legacy
 * `/projects/p/...` routes remain for bookmarks and normalize in the
 * projects controller.
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      redirect: { name: "projects" },
    },
    {
      path: "/login",
      name: "login",
      component: () => import("~/pages/Login/Login.page.vue"),
      meta: { public: true, guestOnly: true },
    },
    {
      path: "/setup",
      name: "setup",
      component: () => import("~/pages/Setup/Setup.page.vue"),
      meta: { public: true, setupOnly: true },
    },
    {
      path: "/projects",
      name: "projects",
      component: () => import("~/pages/Projects/Projects.page.vue"),
    },
    {
      path: "/projects/:workspaceSlug/:projectRef",
      name: "project",
      component: () => import("~/pages/Projects/Projects.page.vue"),
    },
    {
      path: "/projects/:workspaceSlug/:projectRef/all",
      name: "project-overview",
      component: () => import("~/pages/Projects/Projects.page.vue"),
    },
    {
      path: "/projects/:workspaceSlug/:projectRef/:environmentName",
      name: "environment",
      component: () => import("~/pages/Projects/Projects.page.vue"),
    },
    {
      path: "/projects/:workspaceSlug/:projectRef/:environmentName/tokens",
      name: "environment-tokens",
      component: () => import("~/pages/Projects/Projects.page.vue"),
    },
    {
      path: "/projects/:workspaceSlug/:projectRef/:environmentName/import",
      name: "environment-import",
      component: () => import("~/pages/Projects/ImportSecrets.page.vue"),
    },
    {
      path: "/projects/p/:projectRef",
      name: "project-legacy",
      component: () => import("~/pages/Projects/Projects.page.vue"),
    },
    {
      path: "/projects/p/:projectRef/all",
      name: "project-overview-legacy",
      component: () => import("~/pages/Projects/Projects.page.vue"),
    },
    {
      path: "/projects/p/:projectRef/e/:environmentId",
      name: "environment-legacy",
      component: () => import("~/pages/Projects/Projects.page.vue"),
    },
    {
      path: "/projects/p/:projectRef/e/:environmentId/tokens",
      name: "environment-tokens-legacy",
      component: () => import("~/pages/Projects/Projects.page.vue"),
    },
    {
      path: "/projects/p/:projectRef/e/:environmentId/import",
      name: "environment-import-legacy",
      component: () => import("~/pages/Projects/ImportSecrets.page.vue"),
    },
    {
      path: "/backups",
      name: "backups",
      component: () => import("~/pages/Backups/Backups.page.vue"),
      meta: { rootOnly: true },
    },
    {
      path: "/audit",
      name: "audit",
      component: () => import("~/pages/Audit/Audit.page.vue"),
      meta: { adminOnly: true },
    },
    {
      path: "/instance",
      name: "instance",
      component: () => import("~/pages/Instance/Instance.page.vue"),
    },
    {
      path: "/account",
      name: "account",
      component: () => import("~/pages/Account/Account.page.vue"),
    },
    {
      path: "/users",
      name: "users",
      component: () => import("~/pages/Users/Users.page.vue"),
      meta: { adminOnly: true },
    },
    {
      path: "/:pathMatch(.*)*",
      name: "not-found",
      component: () => import("~/pages/NotFound/NotFound.page.vue"),
      meta: { public: true },
    },
  ],
});

installRouterGuards(router);
