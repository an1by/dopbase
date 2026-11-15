import { ApiClient } from "../harness/api.ts";
import {
  about,
  expect,
  ROOT_EMAIL,
  ROOT_PASSWORD,
  step,
  test,
  useServer,
} from "../harness/index.ts";
import { expectError, expectOk } from "./support.ts";

const app = useServer({ env: { DOPBASE_RBAC: "true" } });

test(
  "read instance settings",
  {
    tag: "@admin",
    annotation: about(
      "GET /instance reports version, public URL, readiness and key health to roles with instance.view; Members get 403 and anonymous callers 401.",
    ),
  },
  async () => {
    await step("GET /instance as root", async () => {
      const instance = expectOk(await app.api.get("/instance"));
      expect(instance).toMatchObject({
        publicUrl: app.url,
        initializationState: "ready",
        databaseHealth: "healthy",
        keyAvailability: "available",
      });
      expect(instance.version).toMatch(/^\d+\.\d+\.\d+/);
    });
    await step("GET /instance as an Admin", async () => {
      const admin = await app.apiAs(await app.make.user({ role: "Admin" }));
      expect(expectOk(await admin.get("/instance")).initializationState).toBe(
        "ready",
      );
    });
    await step("GET /instance as a Member is 403", async () => {
      const member = await app.apiAs(await app.make.user());
      expectError(await member.get("/instance"), 403, "AUTHORIZATION_DENIED");
    });
    await step("GET /instance without a session is 401", async () => {
      expectError(await (await app.anonymousApi()).get("/instance"), 401);
    });
  },
);

test(
  "factory reset needs root, the confirmation and the password",
  {
    tag: "@admin",
    annotation: about(
      "The reset preview counts what would go; the reset itself is root-only and refuses a missing confirmation (400) or a wrong password (401). With both it wipes the instance back to setup.",
    ),
  },
  async () => {
    // This test wipes the server, so it runs last in the file.
    const env = await app.make.environment();
    await app.make.secret(env, "API_KEY");
    const admin = await app.apiAs(await app.make.user({ role: "Admin" }));
    await step("GET /instance/factory-reset previews the counts", async () => {
      const preview = expectOk(await app.api.get("/instance/factory-reset"));
      expect(preview.projects).toBeGreaterThanOrEqual(1);
      expect(preview.secrets).toBeGreaterThanOrEqual(1);
      expect(preview.users).toBeGreaterThanOrEqual(2);
    });
    await step("An Admin can't preview or reset (403)", async () => {
      expectError(
        await admin.get("/instance/factory-reset"),
        403,
        "AUTHORIZATION_DENIED",
      );
      expectError(
        await admin.post("/instance/factory-reset", {
          confirmation: "FACTORY RESET",
          acknowledged: true,
          currentPassword: ROOT_PASSWORD,
        }),
        403,
        "AUTHORIZATION_DENIED",
      );
    });
    await step("Without a session the preview is 401", async () => {
      expectError(
        await (await app.anonymousApi()).get("/instance/factory-reset"),
        401,
      );
    });
    await step(
      "POST /instance/factory-reset without the typed confirmation is 400",
      async () => {
        expectError(
          await app.api.post("/instance/factory-reset", {
            confirmation: "reset",
            acknowledged: true,
            currentPassword: ROOT_PASSWORD,
          }),
          400,
          "RESET_CONFIRMATION_REQUIRED",
        );
      },
    );
    await step(
      "POST /instance/factory-reset with a wrong password is 401",
      async () => {
        expectError(
          await app.api.post("/instance/factory-reset", {
            confirmation: "FACTORY RESET",
            acknowledged: true,
            currentPassword: "not-the-root-password",
          }),
          401,
          "AUTHENTICATION_INVALID",
        );
      },
    );
    await step("Nothing was wiped by the refused attempts", async () => {
      expect(
        expectOk(await app.api.get(`/environments/${env.id}`)).secretCount,
      ).toBe(1);
    });
    await step(
      "POST /instance/factory-reset with confirmation and password",
      async () => {
        expectOk(
          await app.api.post("/instance/factory-reset", {
            confirmation: "FACTORY RESET",
            acknowledged: true,
            currentPassword: ROOT_PASSWORD,
          }),
        );
      },
    );
    await step(
      "The instance is back to setup and root's session is gone",
      async () => {
        const fresh = await ApiClient.create(app.url, "fresh", []);
        expect(expectOk(await fresh.get("/bootstrap/status")).state).toBe(
          "setupRequired",
        );
        expectError(
          await fresh.post("/auth/login", {
            email: ROOT_EMAIL,
            password: ROOT_PASSWORD,
            sessionKind: "browser",
          }),
          401,
        );
        await fresh.dispose();
        expect((await app.api.get("/auth/session")).status).toBe(401);
      },
    );
  },
);
