// What the harness records about each test: the commands, routes and pages
// it hit (read by e2e/coverage/check.ts) and the plain-words description
// shown in the report.
import { test } from "@playwright/test";

export type HitKind = "cli" | "api" | "ui";

/** Annotation type the reporter reads for coverage hits. */
export const HIT_ANNOTATION = "covers";
/** Annotation type the reporter reads for a test's description. */
export const DESCRIPTION_ANNOTATION = "description";

/** Records that the running test hit a command, route or page. */
export function recordHit(kind: HitKind, value: string): void {
  let info;
  try {
    info = test.info();
  } catch {
    // Outside a test (beforeAll, a factory in setup): not counted.
    return;
  }
  const description = `${kind} ${value}`;
  if (
    !info.annotations.some(
      (a) => a.type === HIT_ANNOTATION && a.description === description,
    )
  ) {
    info.annotations.push({ type: HIT_ANNOTATION, description });
  }
}

/**
 * The plain-words description the report shows under the test title. Pass it
 * as the test's `annotation` option:
 *
 *   test("…", { tag: "@secrets", annotation: about("What it checks.") }, …)
 */
export function about(text: string) {
  return { type: DESCRIPTION_ANNOTATION, description: text };
}
