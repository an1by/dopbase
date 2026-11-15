import { about, expect, step, test, useServer } from "../harness/index.ts";
import { expectError, expectOk, runnerToken } from "./support.ts";

const app = useServer();

test(
  "a runner token reads its environment's secrets",
  {
    tag: "@run",
    annotation: about(
      "GET /runtime/secrets with a runner token returns its environment's values with an ETag, answers 304 when nothing changed, and checks a reference when one is given.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const apiKey = await app.make.secret(env, "API_KEY");
    const dbUrl = await app.make.secret(env, "DB_URL");
    const runner = await runnerToken(app, env);
    const api = await app.apiWithToken(runner.token);
    const etag = await step(
      "GET /runtime/secrets with the runner token",
      async () => {
        const result = await api.get("/runtime/secrets");
        const data = expectOk(result);
        expect(data).toMatchObject({
          project: env.projectName,
          environment: env.name,
          environmentId: env.id,
        });
        const values = Object.fromEntries(
          data.entries.map((e: { key: string; value: string }) => [
            e.key,
            e.value,
          ]),
        );
        expect(values).toEqual({ API_KEY: apiKey, DB_URL: dbUrl });
        expect(result.headers.etag).toBeTruthy();
        return result.headers.etag!;
      },
    );
    await step("The same request with If-None-Match is 304", async () => {
      const result = await api.send("GET", "/runtime/secrets", undefined, {
        headers: { "if-none-match": etag },
      });
      expect(result.status).toBe(304);
    });
    await step(
      "GET /runtime/secrets?reference={project}/{env} matches",
      async () => {
        expectOk(await api.get(`/runtime/secrets?reference=${env.ref}`));
      },
    );
    const rotated = await app.make.secret(env, "API_KEY");
    await step("After a change the old ETag no longer matches", async () => {
      const result = await api.send("GET", "/runtime/secrets", undefined, {
        headers: { "if-none-match": etag },
      });
      const data = expectOk(result);
      expect(
        data.entries.find((e: { key: string }) => e.key === "API_KEY").value,
      ).toBe(rotated);
    });
    await step(
      "GET /environments/{id}/secrets/runtime with the runner token",
      async () => {
        const data = expectOk(
          await api.get(`/environments/${env.id}/secrets/runtime`),
        );
        expect(data.environmentId).toBe(env.id);
        expect(data.entries).toHaveLength(2);
      },
    );
    await step("The runner token can't use account routes (403)", async () => {
      expectError(await api.get("/projects"), 403, "AUTHORIZATION_DENIED");
      expectError(
        await api.post(`/environments/${env.id}/secrets/API_KEY/reveal`),
        403,
      );
    });
    await api.dispose();
  },
);

test(
  "a revoked runner token gets 401",
  {
    tag: "@run",
    annotation: about(
      "After POST /tokens/{id}/revoke the same runner token is refused with 401, and a made-up token is 401 too.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    await app.make.secret(env, "API_KEY");
    const runner = await runnerToken(app, env);
    const api = await app.apiWithToken(runner.token);
    await step("GET /runtime/secrets works before the revoke", async () => {
      expectOk(await api.get("/runtime/secrets"));
    });
    await step("POST /tokens/{id}/revoke", async () => {
      expectOk(await app.api.post(`/tokens/${runner.id}/revoke`));
    });
    await step(
      "GET /runtime/secrets with the revoked token is 401",
      async () => {
        expectError(await api.get("/runtime/secrets"), 401);
      },
    );
    await step("GET /runtime/secrets with a made-up token is 401", async () => {
      const fake = await app.apiWithToken("dbs_notarealtokenatall");
      expectError(await fake.get("/runtime/secrets"), 401);
      await fake.dispose();
    });
    await step("GET /runtime/secrets without a token is 401", async () => {
      expectError(
        await (await app.anonymousApi()).get("/runtime/secrets"),
        401,
      );
    });
    await api.dispose();
  },
);

test(
  "a runner token for another environment gets 403",
  {
    tag: "@run",
    annotation: about(
      "A runner token is tied to one environment: asking for another one by reference or id is 403 TOKEN_SCOPE_INVALID, and a person's session can't use the runner-only route.",
    ),
  },
  async () => {
    const project = await app.make.project();
    const dev = await app.make.environment({ project, name: "dev" });
    const prod = await app.make.environment({ project, name: "prod" });
    await app.make.secret(prod, "API_KEY");
    const runner = await runnerToken(app, dev);
    const api = await app.apiWithToken(runner.token);
    await step(
      "GET /runtime/secrets?reference={project}/prod is 403",
      async () => {
        expectError(
          await api.get(`/runtime/secrets?reference=${prod.ref}`),
          403,
          "TOKEN_SCOPE_INVALID",
        );
      },
    );
    await step("GET /environments/{prod}/secrets/runtime is 403", async () => {
      expectError(
        await api.get(`/environments/${prod.id}/secrets/runtime`),
        403,
        "TOKEN_SCOPE_INVALID",
      );
    });
    await step(
      "Root's session on /runtime/secrets is 403 RUNNER_TOKEN_REQUIRED",
      async () => {
        expectError(
          await app.api.get("/runtime/secrets"),
          403,
          "RUNNER_TOKEN_REQUIRED",
        );
      },
    );
    await step(
      "Root's session reads /environments/{prod}/secrets/runtime",
      async () => {
        const data = expectOk(
          await app.api.get(`/environments/${prod.id}/secrets/runtime`),
        );
        expect(data.entries.map((e: { key: string }) => e.key)).toEqual([
          "API_KEY",
        ]);
      },
    );
    await api.dispose();
  },
);
