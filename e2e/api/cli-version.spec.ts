import { about, expect, step, test, useServer } from "../harness/index.ts";
import { expectError, expectOk } from "./support.ts";

const app = useServer();

const UPGRADE =
  "This server needs Dopbase CLI 0.2.0 or newer, and this one is 0.1.9. Update it with: curl -fsSL https://dopbase.com/install.sh | sh";

test(
  "every API response names the server version",
  {
    tag: "@compat",
    annotation: about(
      "`X-Dopbase-Version` on /health, a signed-in call and a 401 matches the version /health reports, so a CLI learns it from any response.",
    ),
  },
  async () => {
    const anonymous = await app.anonymousApi();
    const health = await step("GET /health", async () =>
      anonymous.get("/health"),
    );
    const version = expectOk(health).version;
    expect(health.headers["x-dopbase-version"]).toBe(version);
    await step("GET /projects as root carries the header", async () => {
      const projects = await app.api.get("/projects");
      expectOk(projects);
      expect(projects.headers["x-dopbase-version"]).toBe(version);
    });
    await step(
      "GET /projects without a session: 401, same header",
      async () => {
        const refused = await anonymous.get("/projects");
        expectError(refused, 401);
        expect(refused.headers["x-dopbase-version"]).toBe(version);
      },
    );
  },
);

test(
  "a Dopbase CLI older than 0.2.0 is told to update",
  {
    tag: "@compat",
    annotation: about(
      "A request saying `User-Agent: dopbase/0.1.9` gets 400 CLI_UPGRADE_REQUIRED with both versions and the install command, even when signed in. /health still answers it.",
    ),
  },
  async () => {
    const headers = { "user-agent": "dopbase/0.1.9" };
    await step("GET /projects as dopbase/0.1.9", async () => {
      const refused = await app.api.send("GET", "/projects", undefined, {
        headers,
      });
      expectError(refused, 400, "CLI_UPGRADE_REQUIRED");
      expect(refused.body.error.CLI_UPGRADE_REQUIRED).toBe(UPGRADE);
      expect(refused.headers["x-dopbase-version"]).toBeTruthy();
    });
    await step("GET /health as dopbase/0.1.9 still answers", async () => {
      expectOk(await app.api.send("GET", "/health", undefined, { headers }));
    });
  },
);

test(
  "browsers, scripts and current CLIs pass the version check",
  {
    tag: "@compat",
    annotation: about(
      "Only a Dopbase CLI that names an older version is refused: the current CLI, curl, a browser and an unparsable dopbase/ agent all get 200.",
    ),
  },
  async () => {
    const health = expectOk(await app.api.get("/health"));
    for (const agent of [
      `dopbase/${health.version}`,
      "curl/8.7.1",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      "dopbase/not-a-version",
    ]) {
      await step(`GET /projects as ${agent}`, async () => {
        expectOk(
          await app.api.send("GET", "/projects", undefined, {
            headers: { "user-agent": agent },
          }),
        );
      });
    }
  },
);
