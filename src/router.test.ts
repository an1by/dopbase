import { describe, expect, it } from "vitest";
import { router } from "./router";

describe("project routes", () => {
  it.each([
    ["/projects", "projects"],
    ["/projects/default/billing", "project"],
    ["/projects/default/billing/all", "project-overview"],
    ["/projects/default/billing/staging", "environment"],
    ["/projects/default/billing/staging/tokens", "environment-tokens"],
    ["/projects/default/billing/staging/import", "environment-import"],
    ["/projects/p/billing", "project-legacy"],
    ["/projects/p/billing/e/env_1", "environment-legacy"],
    ["/projects/p/billing/e/env_1/tokens", "environment-tokens-legacy"],
    ["/projects/p/billing/e/env_1/import", "environment-import-legacy"],
    ["/workspace", "not-found"],
  ])("resolves %s", (path, routeName) => {
    expect(router.resolve(path).name).toBe(routeName);
  });
});
