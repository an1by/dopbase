import { defineConfig, devices } from "@playwright/test";

// Every spec file boots its own server through useServer() in
// harness/index.ts, so files run in parallel and tests inside a file run in
// order. All output goes to ../.e2e/, which git ignores.
const agent = Boolean(process.env.E2E_AGENT);
const ci = Boolean(process.env.CI);

export default defineConfig({
  testMatch: "**/*.spec.ts",
  outputDir: "../.e2e/results",
  fullyParallel: false,
  workers: ci ? 2 : "50%",
  retries: ci ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["./harness/reporter.ts", { outputFile: "../.e2e/last-run.json" }],
    ["html", { outputFolder: "../.e2e/playwright", open: "never" }],
    [agent ? "null" : "list"],
  ],
  use: {
    // A click or fill that can't happen fails in 15 s with a clear message
    // instead of waiting out the whole test.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "cli", testDir: "./cli" },
    { name: "api", testDir: "./api" },
    { name: "ui", testDir: "./ui", use: { ...devices["Desktop Chrome"] } },
    {
      name: "journeys",
      testDir: "./journeys",
      timeout: 120_000,
      // Journeys are whole tasks a person would do, so every run keeps a
      // video to watch, passed or not. The other suites keep one on failure.
      use: { ...devices["Desktop Chrome"], video: "on" },
    },
  ],
});
