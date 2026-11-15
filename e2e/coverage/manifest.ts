// Coverage settings for e2e/coverage/check.ts.
//
// Every CLI command, API route and Admin UI page needs an e2e test in its own
// suite (cli/, api/, ui/). When one truly can't be tested end to end, add it
// to that suite's file in skips/ with the reason. Keys look like the coverage
// table prints them:
//
//   "cli update": "…"
//   "api POST /api/v1/instance/factory-reset": "…"
//   "ui /sso/confirmed": "…"

import { skip as api } from "./skips/api.ts";
import { skip as cli } from "./skips/cli.ts";
import { skip as ui } from "./skips/ui.ts";

/**
 * Strict mode fails the run on a missing entry or on a test without a
 * description and named steps. It only applies to full runs (all four
 * projects, no --grep); partial runs always just report.
 */
export const strict = true;

export const skip: Record<string, string> = { ...cli, ...api, ...ui };
