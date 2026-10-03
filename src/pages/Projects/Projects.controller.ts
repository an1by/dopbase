import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import * as projectsApi from "~/services/projects.api";
import * as environmentsApi from "~/services/environments.api";
import * as secretsApi from "~/services/secrets.api";
import * as tokensApi from "~/services/tokens.api";
import * as workspacesApi from "~/services/workspaces.api";
import type { AffectedCounts, Environment, Project } from "~/services";
import { DEFAULT_WORKSPACE_ID } from "~/constants/workspaces";

/**
 * Projects controller: project and environment rail data, URL-derived
 * selection, and project/environment CRUD.
 *
 * The selected project is addressed by its unique name and the selected
 * environment by its immutable id — both live exclusively in the URL.
 * Mutating actions throw on failure so calling dialogs can render errors.
 * navigation happens only after success.
 */
export function useProjectsController() {
  const route = useRoute();
  const router = useRouter();

  const allProjects = ref<Project[] | null>(null);
  const workspaces = ref<workspacesApi.Workspace[]>([]);
  const workspacesError = ref<string | null>(null);
  const workspaceId = ref(
    typeof route.query?.workspace === "string" && route.query.workspace
      ? route.query.workspace
      : DEFAULT_WORKSPACE_ID,
  );
  const projects = computed(
    () =>
      allProjects.value?.filter(
        (item) =>
          (item.workspaceId ?? DEFAULT_WORKSPACE_ID) === workspaceId.value,
      ) ?? null,
  );
  const workspace = computed(() => workspaces.value.find((item) => item.id === workspaceId.value) ?? null);
  const projectsError = ref<string | null>(null);
  const environments = ref<Environment[] | null>(null);
  const environmentsLoading = ref(false);
  const environmentsError = ref<string | null>(null);
  let projectsRequest: AbortController | null = null;
  let environmentsRequest: AbortController | null = null;

  const projectRef = computed(() =>
    typeof route.params.projectRef === "string"
      ? route.params.projectRef
      : null,
  );
  const environmentId = computed(() =>
    typeof route.params.environmentId === "string"
      ? route.params.environmentId
      : null,
  );
  const isProjectOverview = computed(() => route.name === "project-overview");
  const activeTab = computed(() =>
    route.name === "environment-tokens" ? "tokens" : "secrets",
  );

  const project = computed(() => {
    const ref = projectRef.value;
    const list = allProjects.value;
    if (!ref || !list) return null;
    if (ref.startsWith("prj_")) {
      return list.find((candidate) => candidate.id === ref) ?? null;
    }
    const inWorkspace = list.filter(
      (candidate) =>
        candidate.name === ref &&
        (candidate.workspaceId ?? DEFAULT_WORKSPACE_ID) === workspaceId.value,
    );
    if (inWorkspace.length === 1) return inWorkspace[0];
    const matches = list.filter(
      (candidate) => candidate.name === ref || candidate.id === ref,
    );
    return matches.length === 1 ? matches[0] : null;
  });
  const selectedEnvironment = computed(
    () =>
      environments.value?.find(
        (candidate) => candidate.id === environmentId.value,
      ) ?? null,
  );

  async function loadProjects(): Promise<void> {
    projectsRequest?.abort();
    const request = new AbortController();
    projectsRequest = request;
    projectsError.value = null;
    try {
      const result = await projectsApi.listProjects(request.signal);
      if (!request.signal.aborted) {
        allProjects.value = result;
        const active = result.find((item) => item.id === projectRef.value || item.name === projectRef.value);
        if (active) {
          workspaceId.value = active.workspaceId ?? DEFAULT_WORKSPACE_ID;
        }
      }
    } catch {
      if (request.signal.aborted) return;
      projectsError.value = "Could not load projects.";
      allProjects.value = null;
    }
  }

  async function loadEnvironments(): Promise<void> {
    environmentsRequest?.abort();
    const reference = projectRef.value;
    if (!reference) {
      environments.value = null;
      environmentsLoading.value = false;
      return;
    }
    const request = new AbortController();
    environmentsRequest = request;
    environmentsLoading.value = true;
    environmentsError.value = null;
    // Drop the previous project's list immediately: otherwise selection
    // logic could act on a stale list while the new one is in flight and
    // open an environment that belongs to the old project.
    environments.value = null;
    try {
      const result = await environmentsApi.listEnvironments(
        reference,
        request.signal,
      );
      if (!request.signal.aborted && projectRef.value === reference) {
        environments.value = result;
      }
    } catch {
      if (request.signal.aborted || projectRef.value !== reference) return;
      environmentsError.value = "Could not load environments.";
      environments.value = null;
    } finally {
      if (environmentsRequest === request) environmentsLoading.value = false;
    }
  }

  watch(projectRef, loadEnvironments, { immediate: true });
  onMounted(loadProjects);
  onMounted(loadWorkspaces);
  onUnmounted(() => {
    projectsRequest?.abort();
    environmentsRequest?.abort();
  });

  // Landing on /projects with existing projects opens the first project.
  watch(projects, (list) => {
    if (list && list.length > 0 && !projectRef.value) {
      router.replace({
        name: "project",
        params: { projectRef: list[0].name },
      });
    }
  });

  // Opening a project without an environment selects its first one.
  watch([environments, environmentId], ([list, id]) => {
    if (isProjectOverview.value) return;
    if (route.name === "project" && list && list.length > 0 && !id) {
      router.replace({
        name: "environment",
        params: {
          projectRef: projectRef.value as string,
          environmentId: list[0].id,
        },
      });
    }
  });

  function selectProject(refName: string): void {
    if (refName === projectRef.value) return;
    router.push({ name: "project", params: { projectRef: refName } });
  }

  function ensureWorkspaceSelected(): void {
    if (
      workspaceId.value &&
      workspaces.value.some((item) => item.id === workspaceId.value)
    ) {
      return;
    }
    const fallback =
      workspaces.value.find((item) => item.id === DEFAULT_WORKSPACE_ID) ??
      workspaces.value[0];
    if (fallback) workspaceId.value = fallback.id;
  }

  async function loadWorkspaces(): Promise<void> {
    workspacesError.value = null;
    try {
      workspaces.value = await workspacesApi.listWorkspaces();
      ensureWorkspaceSelected();
    } catch {
      workspacesError.value = "Could not load workspaces.";
    }
  }

  function selectWorkspace(id: string): void {
    workspaceId.value = id;
    const first = projects.value?.[0];
    router.push(first ? { name: "project", params: { projectRef: first.name } } : { name: "projects", query: { workspace: id } });
  }

  watch(project, (value) => {
    if (value) workspaceId.value = value.workspaceId ?? DEFAULT_WORKSPACE_ID;
  });
  watch(
    () => route.query?.workspace,
    (value) => {
      if (projectRef.value) return;
      workspaceId.value =
        typeof value === "string" && value ? value : DEFAULT_WORKSPACE_ID;
      ensureWorkspaceSelected();
    },
  );

  async function createWorkspace(input: workspacesApi.WorkspaceInput): Promise<void> {
    const created = await workspacesApi.createWorkspace(input);
    await loadWorkspaces(); selectWorkspace(created.id);
  }
  async function updateWorkspace(id: string, input: workspacesApi.WorkspaceInput): Promise<void> {
    await workspacesApi.updateWorkspace(id, input); await loadWorkspaces();
  }
  async function deleteWorkspace(id: string): Promise<void> {
    await workspacesApi.deleteWorkspace(id);
    await loadWorkspaces();
    ensureWorkspaceSelected();
    selectWorkspace(workspaceId.value);
  }
  async function setProjectLocation(id: string, workspaceId: string | null, path: string | null): Promise<void> {
    await projectsApi.setProjectLocation(id, workspaceId, path); await loadProjects();
  }

  function showAllEnvironments(): void {
    if (projectRef.value) router.push({ name: "project-overview", params: { projectRef: projectRef.value } });
  }

  function selectEnvironment(id: string): void {
    if (!projectRef.value || id === environmentId.value) return;
    router.push({
      name: "environment",
      params: { projectRef: projectRef.value, environmentId: id },
    });
  }

  function switchTab(tab: "secrets" | "tokens"): void {
    if (!projectRef.value || !environmentId.value) return;
    router.push({
      name: tab === "tokens" ? "environment-tokens" : "environment",
      params: {
        projectRef: projectRef.value,
        environmentId: environmentId.value,
      },
    });
  }

  async function createProject(name: string): Promise<void> {
    const created = await projectsApi.createProject(name);
    if (workspaceId.value) await projectsApi.setProjectLocation(created.id, workspaceId.value, name);
    await loadProjects();
    router.push({ name: "project", params: { projectRef: created.name } });
  }

  async function renameProject(projectId: string, name: string): Promise<void> {
    const renamingActiveProject = project.value?.id === projectId;
    const updated = await projectsApi.renameProject(projectId, name);
    await loadProjects();
    if (!renamingActiveProject) return;
    if (environmentId.value) {
      router.replace({
        name: "environment",
        params: {
          projectRef: updated.name,
          environmentId: environmentId.value,
        },
      });
    } else {
      router.replace({
        name: "project",
        params: { projectRef: updated.name },
      });
    }
  }

  async function deleteProject(projectId: string): Promise<AffectedCounts> {
    const deletingActiveProject = project.value?.id === projectId;
    const affected = await projectsApi.deleteProject(projectId);
    await loadProjects();
    if (deletingActiveProject) router.replace({ name: "projects" });
    return affected;
  }

  async function createEnvironment(name: string): Promise<void> {
    if (!projectRef.value) return;
    const created = await environmentsApi.createEnvironment(
      projectRef.value,
      name,
    );
    await loadEnvironments();
    router.push({
      name: "environment",
      params: { projectRef: projectRef.value, environmentId: created.id },
    });
  }

  async function renameEnvironment(id: string, name: string): Promise<void> {
    await environmentsApi.renameEnvironment(id, name);
    await loadEnvironments();
  }

  async function deleteEnvironment(id: string): Promise<AffectedCounts> {
    const affected = await environmentsApi.deleteEnvironment(id);
    await loadEnvironments();
    if (environmentId.value === id && projectRef.value) {
      router.replace({
        name: "project",
        params: { projectRef: projectRef.value },
      });
    }
    return affected;
  }

  /** Affected-count preview for the destructive environment dialog. */
  async function describeEnvironmentDeletion(
    id: string,
  ): Promise<Array<{ label: string; count: number }>> {
    const [secrets, tokens] = await Promise.all([
      secretsApi.listSecrets(id),
      tokensApi.listTokens(id),
    ]);
    return [
      { label: "secrets", count: secrets.length },
      { label: "runner tokens", count: tokens.length },
    ];
  }

  return {
    isProjectOverview,
    workspaces, workspacesError, workspaceId, workspace, loadWorkspaces,
    selectWorkspace, createWorkspace, updateWorkspace, deleteWorkspace, setProjectLocation, showAllEnvironments,
    projects,
    projectsError,
    loadProjects,
    environments,
    environmentsLoading,
    environmentsError,
    projectRef,
    environmentId,
    activeTab,
    project,
    selectedEnvironment,
    selectProject,
    selectEnvironment,
    switchTab,
    createProject,
    renameProject,
    deleteProject,
    createEnvironment,
    renameEnvironment,
    deleteEnvironment,
    describeEnvironmentDeletion,
  };
}

export type ProjectsController = ReturnType<typeof useProjectsController>;
