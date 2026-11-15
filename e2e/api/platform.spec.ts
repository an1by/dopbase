import { about, expect, step, test, useServer } from "../harness/index.ts";
import { expectError, expectOk } from "./support.ts";

const app = useServer({ docs: true });

test(
  "health answers ok",
  {
    tag: "@smoke",
    annotation: about(
      "The health endpoint answers 200 with success true on a fresh server, without signing in.",
    ),
  },
  async () => {
    const api = await app.anonymousApi();
    await step("GET /health without a session", async () => {
      const health = await api.get("/health");
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ success: true });
    });
  },
);

test(
  "OpenAPI document and Swagger UI load",
  {
    tag: "@smoke",
    annotation: about(
      "With --docs the server serves /api/v1/openapi.json listing the v1 routes, and Swagger UI at /api/docs.",
    ),
  },
  async ({ request }) => {
    await step("GET /api/v1/openapi.json lists the v1 routes", async () => {
      const res = await request.get("/api/v1/openapi.json");
      expect(res.status()).toBe(200);
      const doc = await res.json();
      expect(doc.openapi).toMatch(/^3\./);
      expect(Object.keys(doc.paths)).toContain("/api/v1/health");
      expect(Object.keys(doc.paths).length).toBeGreaterThan(50);
    });
    await step("GET /api/docs/ serves the Swagger UI page", async () => {
      const res = await request.get("/api/docs/");
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/html");
      expect(await res.text()).toMatch(/swagger/i);
    });
  },
);

test(
  "the Admin UI shell is served at / and /launch",
  {
    tag: "@smoke",
    annotation: about(
      "The embedded single-page app answers / and deep links such as /launch with the same HTML shell, while unknown API paths stay JSON 404s.",
    ),
  },
  async ({ request }) => {
    for (const path of ["/", "/launch"]) {
      await step(`GET ${path} returns the SPA shell`, async () => {
        const res = await request.get(path);
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toContain("text/html");
        expect(await res.text()).toContain("<title>Dopbase Console</title>");
      });
    }
    await step(
      "An unknown /api/v1 path is a JSON 404, not the SPA",
      async () => {
        const res = await request.get("/api/v1/does-not-exist");
        expect(res.status()).toBe(404);
        expect(res.headers()["content-type"]).toContain("application/json");
      },
    );
  },
);

test(
  "status page and on-demand checks",
  {
    tag: "@smoke",
    annotation: about(
      "GET /status needs a session and reports counts and checks; POST /status/checks/run reruns them and refuses a second run right away.",
    ),
  },
  async () => {
    const anonymous = await app.anonymousApi();
    await step("GET /status without a session is 401", async () => {
      expectError(
        await anonymous.get("/status"),
        401,
        "AUTHENTICATION_REQUIRED",
      );
    });
    await step("POST /status/checks/run without a session is 401", async () => {
      expectError(
        await anonymous.post("/status/checks/run"),
        401,
        "AUTHENTICATION_REQUIRED",
      );
    });
    await step(
      "GET /status as root shows version, counts and checks",
      async () => {
        const status = expectOk(await app.api.get("/status"));
        expect(status.version).toMatch(/^\d+\.\d+\.\d+/);
        expect(status.initializationState).toBe("ready");
        expect(status.humanUsers).toBeGreaterThanOrEqual(1);
        expect(status.checks.map((c: { id: string }) => c.id)).toContain(
          "database.ping",
        );
      },
    );
    await step("POST /status/checks/run reruns every check", async () => {
      const run = expectOk(await app.api.post("/status/checks/run"));
      expect(run.summary.passed).toBeGreaterThan(0);
      expect(
        run.checks.find((c: { id: string }) => c.id === "database.ping")
          ?.status,
      ).toBe("ok");
    });
    await step("A second run straight away is rate limited (429)", async () => {
      expectError(
        await app.api.post("/status/checks/run"),
        429,
        "RATE_LIMITED",
      );
    });
  },
);
