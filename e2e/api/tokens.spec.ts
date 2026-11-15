import { grant } from "../harness/helpers.ts";
import { about, expect, step, test, useServer } from "../harness/index.ts";
import { expectError, expectOk } from "./support.ts";

// Members (for the 403 case) need RBAC.
const app = useServer({ env: { DOPBASE_RBAC: "true" } });

test(
  "runner token create, list and revoke",
  {
    tag: "@tokens",
    annotation: about(
      "Creating a runner token shows its secret once; the list never shows it again; revoking stamps revokedAt and a second revoke is 409.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const created = await step(
      "POST /environments/{id}/tokens ci-deploy",
      async () => {
        const result = expectOk(
          await app.api.post(`/environments/${env.id}/tokens`, {
            name: "ci-deploy",
            role: "runner",
            expiresIn: "30d",
          }),
          201,
        );
        expect(result.plaintextToken).toMatch(/^dbs_/);
        expect(result.token).toMatchObject({
          name: "ci-deploy",
          environmentId: env.id,
          revokedAt: null,
        });
        expect(result.token.expiresAt).toBeTruthy();
        return result;
      },
    );
    await step(
      "GET /environments/{id}/tokens lists it without the secret",
      async () => {
        const list = expectOk(
          await app.api.get(`/environments/${env.id}/tokens`),
        );
        expect(list).toEqual([
          expect.objectContaining({ id: created.token.id }),
        ]);
        expect(JSON.stringify(list)).not.toContain(created.plaintextToken);
      },
    );
    await step("A duplicate name in the same environment is 409", async () => {
      expect(
        (
          await app.api.post(`/environments/${env.id}/tokens`, {
            name: "ci-deploy",
            role: "runner",
          })
        ).status,
      ).toBe(409);
    });
    await step("POST /tokens/{id}/revoke", async () => {
      expectOk(await app.api.post(`/tokens/${created.token.id}/revoke`));
    });
    await step("The list shows it revoked", async () => {
      const list = expectOk(
        await app.api.get(`/environments/${env.id}/tokens`),
      );
      expect(list[0].revokedAt).toBeTruthy();
    });
    await step("Revoking it again is 409", async () => {
      expectError(
        await app.api.post(`/tokens/${created.token.id}/revoke`),
        409,
        "TOKEN_REVOKED",
      );
    });
    await step("Revoking an unknown token is 404", async () => {
      expectError(
        await app.api.post("/tokens/tok_unknown/revoke"),
        404,
        "TOKEN_NOT_FOUND",
      );
    });
  },
);

test(
  "runner token validation and access",
  {
    tag: "@tokens",
    annotation: about(
      "Only the runner role and slug names are accepted (422), unknown environments are 404, no session is 401, and a Member below manage can't create or list tokens (403).",
    ),
  },
  async () => {
    const env = await app.make.environment();
    await step("POST …/tokens with role admin is 422", async () => {
      expectError(
        await app.api.post(`/environments/${env.id}/tokens`, {
          name: "ci",
          role: "admin",
        }),
        422,
        "TOKEN_SCOPE_INVALID",
      );
    });
    await step("POST …/tokens with an invalid name is 422", async () => {
      expectError(
        await app.api.post(`/environments/${env.id}/tokens`, {
          name: "Deploy Prod",
          role: "runner",
        }),
        422,
        "TOKEN_NAME_INVALID",
      );
    });
    await step("POST …/tokens on an unknown environment is 404", async () => {
      expectError(
        await app.api.post("/environments/env_000000/tokens", {
          name: "ci",
          role: "runner",
        }),
        404,
        "ENVIRONMENT_NOT_FOUND",
      );
    });
    await step("Token routes without a session are 401", async () => {
      const anonymous = await app.anonymousApi();
      expectError(await anonymous.get(`/environments/${env.id}/tokens`), 401);
      expectError(
        await anonymous.post(`/environments/${env.id}/tokens`, {
          name: "ci",
          role: "runner",
        }),
        401,
      );
      expectError(await anonymous.post("/tokens/tok_x/revoke"), 401);
    });
    const member = await app.make.user();
    await grant(app, member, "write", { environment: env.id });
    const runner = await app.api.must(
      "POST",
      `/environments/${env.id}/tokens`,
      { name: "deploy", role: "runner" },
      { record: false },
    );
    await step(
      "A Member at write can't list, create or revoke tokens (403)",
      async () => {
        const api = await app.apiAs(member);
        expectError(
          await api.get(`/environments/${env.id}/tokens`),
          403,
          "AUTHORIZATION_DENIED",
        );
        expectError(
          await api.post(`/environments/${env.id}/tokens`, {
            name: "mine",
            role: "runner",
          }),
          403,
          "AUTHORIZATION_DENIED",
        );
        expectError(
          await api.post(`/tokens/${runner.token.id}/revoke`),
          403,
          "AUTHORIZATION_DENIED",
        );
      },
    );
  },
);

test(
  "runner tokens always expire",
  {
    tag: "@tokens",
    annotation: about(
      "A runner token without expiresIn lasts 90 days; `never` and anything past a year are 400 EXPIRY_INVALID, so no runner token lives forever.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const create = (expiresIn?: string) =>
      app.api.post(`/environments/${env.id}/tokens`, {
        name: app.uniq("ci"),
        role: "runner",
        ...(expiresIn ? { expiresIn } : {}),
      });
    await step("Without expiresIn the token lasts 90 days", async () => {
      const before = Date.now();
      const created = expectOk(await create(), 201);
      const days =
        (Date.parse(created.token.expiresAt) - before) / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThan(89.9);
      expect(days).toBeLessThan(90.1);
    });
    await step('expiresIn "never" is 400 EXPIRY_INVALID', async () => {
      expectError(await create("never"), 400, "EXPIRY_INVALID");
    });
    await step("More than a year is 400 EXPIRY_INVALID", async () => {
      expectError(await create("400d"), 400, "EXPIRY_INVALID");
    });
    await step("Exactly a year is allowed", async () => {
      expectOk(await create("365d"), 201);
    });
  },
);
