import { grant } from "../harness/helpers.ts";
import { about, expect, step, test, useServer } from "../harness/index.ts";
import { expectError, expectOk } from "./support.ts";

// History keeps 3 versions here, so the retention test can push past it.
// Members (for the 403 cases) need RBAC.
const HISTORY = 3;
const app = useServer({
  env: {
    DOPBASE_RBAC: "true",
    DOPBASE_SECRET_HISTORY_VERSIONS: String(HISTORY),
  },
});

const secretPath = (envId: string, key: string) =>
  `/environments/${envId}/secrets/${key}`;

test(
  "secret create, read, update and delete",
  {
    tag: "@secrets",
    annotation: about(
      "PUT creates version 1 and then version 2, listing and reading show metadata but never values, createOnly refuses to overwrite, bad keys are 422, and DELETE removes the secret.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const [first, second] = [app.value(), app.value()];
    await step(
      "PUT /environments/{id}/secrets/API_KEY creates version 1",
      async () => {
        expect(
          expectOk(
            await app.api.put(secretPath(env.id, "API_KEY"), { value: first }),
          ),
        ).toMatchObject({ key: "API_KEY", version: 1 });
      },
    );
    await step(
      "PUT the same key with a new value saves version 2",
      async () => {
        expect(
          expectOk(
            await app.api.put(secretPath(env.id, "API_KEY"), { value: second }),
          ).version,
        ).toBe(2);
      },
    );
    await step("PUT with createOnly on an existing key is 409", async () => {
      expectError(
        await app.api.put(secretPath(env.id, "API_KEY"), {
          value: app.value(),
          createOnly: true,
        }),
        409,
        "SECRET_VERSION_CONFLICT",
      );
    });
    await step("PUT with an invalid key is 422", async () => {
      expectError(
        await app.api.put(secretPath(env.id, "bad-key"), {
          value: app.value(),
        }),
        422,
        "SECRET_KEY_INVALID",
      );
    });
    await step(
      "GET /environments/{id}/secrets lists keys without values",
      async () => {
        const list = expectOk(
          await app.api.get(`/environments/${env.id}/secrets`),
        );
        expect(list).toEqual([
          expect.objectContaining({ key: "API_KEY", version: 2 }),
        ]);
        expect(JSON.stringify(list)).not.toContain(second);
      },
    );
    await step(
      "GET /environments/{id}/secrets/API_KEY shows metadata only",
      async () => {
        const item = expectOk(await app.api.get(secretPath(env.id, "API_KEY")));
        expect(item).toMatchObject({ key: "API_KEY", version: 2 });
        expect(item.value).toBeUndefined();
      },
    );
    await step("DELETE /environments/{id}/secrets/API_KEY", async () => {
      expectOk(await app.api.delete(secretPath(env.id, "API_KEY")));
    });
    await step(
      "The deleted secret is 404 to read, reveal and delete",
      async () => {
        expectError(
          await app.api.get(secretPath(env.id, "API_KEY")),
          404,
          "SECRET_NOT_FOUND",
        );
        expectError(
          await app.api.post(`${secretPath(env.id, "API_KEY")}/reveal`),
          404,
          "SECRET_NOT_FOUND",
        );
        expectError(
          await app.api.delete(secretPath(env.id, "API_KEY")),
          404,
          "SECRET_NOT_FOUND",
        );
        expect(
          expectOk(await app.api.get(`/environments/${env.id}/secrets`)),
        ).toEqual([]);
      },
    );
    await step("Secret routes on an unknown environment are 404", async () => {
      expectError(
        await app.api.get("/environments/env_000000/secrets"),
        404,
        "ENVIRONMENT_NOT_FOUND",
      );
    });
  },
);

test(
  "secret access needs the right level",
  {
    tag: "@secrets",
    annotation: about(
      "Without a session secret routes are 401; a Member with metadata sees keys but can't reveal (403), and at read can reveal but not write (403).",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const value = await app.make.secret(env, "API_KEY");
    const member = await app.make.user();
    const api = await app.apiAs(member);
    await step("Without a session list, reveal and PUT are 401", async () => {
      const anonymous = await app.anonymousApi();
      expectError(await anonymous.get(`/environments/${env.id}/secrets`), 401);
      expectError(
        await anonymous.post(`${secretPath(env.id, "API_KEY")}/reveal`),
        401,
      );
      expectError(
        await anonymous.put(secretPath(env.id, "API_KEY"), {
          value: app.value(),
        }),
        401,
      );
    });
    await step(
      "A Member with no grant gets 404 for the environment",
      async () => {
        expectError(
          await api.get(`/environments/${env.id}/secrets`),
          404,
          "ENVIRONMENT_NOT_FOUND",
        );
      },
    );
    await grant(app, member, "metadata", { environment: env.id });
    await step(
      "At metadata the Member lists keys but reveal is 403",
      async () => {
        expect(
          expectOk(await api.get(`/environments/${env.id}/secrets`)),
        ).toHaveLength(1);
        expectError(
          await api.post(`${secretPath(env.id, "API_KEY")}/reveal`),
          403,
          "AUTHORIZATION_DENIED",
        );
      },
    );
    await grant(app, member, "read", { environment: env.id });
    await step(
      "At read the Member reveals but PUT and DELETE are 403",
      async () => {
        expect(
          expectOk(await api.post(`${secretPath(env.id, "API_KEY")}/reveal`))
            .value,
        ).toBe(value);
        expectError(
          await api.put(secretPath(env.id, "API_KEY"), { value: app.value() }),
          403,
          "AUTHORIZATION_DENIED",
        );
        expectError(
          await api.delete(secretPath(env.id, "API_KEY")),
          403,
          "AUTHORIZATION_DENIED",
        );
      },
    );
  },
);

test(
  "reveal, versions, version reveal and rollback",
  {
    tag: "@secrets",
    annotation: about(
      "Each write is a version; old versions can be revealed, and rolling back to version 1 saves its value as version 3 without touching history.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const v1 = await app.make.secret(env, "API_KEY");
    const v2 = await app.make.secret(env, "API_KEY");
    const path = secretPath(env.id, "API_KEY");
    await step(
      "POST /environments/{id}/secrets/API_KEY/reveal shows version 2",
      async () => {
        expect(expectOk(await app.api.post(`${path}/reveal`))).toEqual({
          key: "API_KEY",
          value: v2,
          version: 2,
        });
      },
    );
    await step(
      "GET …/API_KEY/versions lists 2 versions, newest first",
      async () => {
        const page = expectOk(await app.api.get(`${path}/versions`));
        expect(page.items.map((v: { version: number }) => v.version)).toEqual([
          2, 1,
        ]);
        expect(page.items[0]).toMatchObject({
          current: true,
          changeType: "updated",
        });
        expect(page.items[1]).toMatchObject({
          current: false,
          changeType: "created",
        });
        expect(page.retainedVersions).toBe(HISTORY);
      },
    );
    await step("GET …/versions?limit=1 pages with nextBefore", async () => {
      const page = expectOk(await app.api.get(`${path}/versions?limit=1`));
      expect(page.items).toHaveLength(1);
      expect(page.nextBefore).toBe(2);
      const next = expectOk(
        await app.api.get(`${path}/versions?limit=1&before=${page.nextBefore}`),
      );
      expect(next.items.map((v: { version: number }) => v.version)).toEqual([
        1,
      ]);
    });
    await step(
      "POST …/API_KEY/versions/1/reveal shows the first value",
      async () => {
        expect(
          expectOk(await app.api.post(`${path}/versions/1/reveal`)).value,
        ).toBe(v1);
      },
    );
    await step("POST …/versions/9/reveal is 404", async () => {
      expectError(
        await app.api.post(`${path}/versions/9/reveal`),
        404,
        "SECRET_VERSION_NOT_FOUND",
      );
    });
    await step(
      "POST …/rollback with a stale expectedVersion is 409",
      async () => {
        expectError(
          await app.api.post(`${path}/rollback`, {
            version: 1,
            expectedVersion: 1,
          }),
          409,
          "SECRET_VERSION_CONFLICT",
        );
      },
    );
    await step("POST …/API_KEY/rollback to version 1", async () => {
      expect(
        expectOk(
          await app.api.post(`${path}/rollback`, {
            version: 1,
            expectedVersion: 2,
          }),
        ),
      ).toMatchObject({
        key: "API_KEY",
        version: 3,
        sourceVersion: 1,
        previousVersion: 2,
      });
    });
    await step("The current value is version 1's, as version 3", async () => {
      expect(expectOk(await app.api.post(`${path}/reveal`))).toMatchObject({
        value: v1,
        version: 3,
      });
    });
    await step(
      "Versions list shows 3 entries, the newest a rollback",
      async () => {
        const page = expectOk(await app.api.get(`${path}/versions`));
        expect(page.items).toHaveLength(3);
        expect(page.items[0]).toMatchObject({
          version: 3,
          sourceVersion: 1,
          current: true,
        });
      },
    );
    await step("Rolling back to the current version is 409", async () => {
      expectError(
        await app.api.post(`${path}/rollback`, { version: 3 }),
        409,
        "SECRET_VERSION_IS_CURRENT",
      );
    });
    await step(
      "Rolling back to a version that never existed is 404",
      async () => {
        expectError(
          await app.api.post(`${path}/rollback`, { version: 42 }),
          404,
          "SECRET_VERSION_NOT_FOUND",
        );
      },
    );
  },
);

test(
  "copy one secret, copy many, and compare two environments",
  {
    tag: "@secrets",
    annotation: about(
      "Copying moves a value from one environment to another, copy-secrets copies a set of keys (or only their names), and compare shows which keys differ.",
    ),
  },
  async () => {
    const project = await app.make.project();
    const dev = await app.make.environment({ project, name: "dev" });
    const prod = await app.make.environment({ project, name: "prod" });
    const apiKey = await app.make.secret(dev, "API_KEY");
    const dbUrl = await app.make.secret(dev, "DB_URL");
    await app.make.secret(dev, "ONLY_DEV");
    await app.make.secret(prod, "DB_URL");
    await step(
      "POST /environments/{prod}/secrets/API_KEY/copy from dev",
      async () => {
        expect(
          expectOk(
            await app.api.post(`${secretPath(prod.id, "API_KEY")}/copy`, {
              from: dev.id,
            }),
          ),
        ).toMatchObject({ key: "API_KEY", version: 1 });
        const revealed = await app.api.must(
          "POST",
          `${secretPath(prod.id, "API_KEY")}/reveal`,
          {},
          { record: false },
        );
        expect(revealed.value).toBe(apiKey);
      },
    );
    await step("Copying a key the source doesn't have is 404", async () => {
      expectError(
        await app.api.post(`${secretPath(prod.id, "MISSING")}/copy`, {
          from: dev.id,
        }),
        404,
        "SECRET_NOT_FOUND",
      );
    });
    await step("GET /environments/{dev}/compare?with={prod}", async () => {
      const compare = expectOk(
        await app.api.get(`/environments/${dev.id}/compare?with=${prod.id}`),
      );
      expect(compare.base.id).toBe(dev.id);
      expect(compare.environments.map((e: { id: string }) => e.id)).toEqual([
        prod.id,
      ]);
      const byKey = Object.fromEntries(
        compare.keys.map((k: { key: string; others: unknown[] }) => [
          k.key,
          k.others[0],
        ]),
      );
      expect(byKey.API_KEY).toMatchObject({ sameAsBase: true });
      expect(byKey.DB_URL).toMatchObject({ sameAsBase: false });
      expect(byKey.ONLY_DEV).toMatchObject({ version: null });
    });
    await step("Compare with an unknown environment is 404", async () => {
      expect(
        (await app.api.get(`/environments/${dev.id}/compare?with=env_000000`))
          .status,
      ).toBe(404);
    });
    await step(
      "POST /environments/{prod}/copy-secrets DB_URL and ONLY_DEV",
      async () => {
        const copied = expectOk(
          await app.api.post(`/environments/${prod.id}/copy-secrets`, {
            from: dev.id,
            keys: ["DB_URL", "ONLY_DEV"],
            values: true,
          }),
        );
        // Keys the target already has are skipped, never overwritten.
        expect(copied.copiedKeys).toEqual(["ONLY_DEV"]);
        expect(copied.skippedKeys).toEqual(["DB_URL"]);
        const revealed = await app.api.must(
          "POST",
          `${secretPath(prod.id, "DB_URL")}/reveal`,
          {},
          { record: false },
        );
        expect(revealed.value).not.toBe(dbUrl);
      },
    );
    await step("POST …/copy-secrets with no keys is 422", async () => {
      expectError(
        await app.api.post(`/environments/${prod.id}/copy-secrets`, {
          from: dev.id,
          keys: [],
        }),
        422,
        "COPY_KEYS_REQUIRED",
      );
    });
    await step("After copying, only DB_URL still differs", async () => {
      const compare = expectOk(
        await app.api.get(`/environments/${dev.id}/compare?with=${prod.id}`),
      );
      const differs = compare.keys
        .filter(
          (k: { others: { sameAsBase: boolean }[] }) => !k.others[0].sameAsBase,
        )
        .map((k: { key: string }) => k.key);
      expect(differs).toEqual(["DB_URL"]);
    });
  },
);

test(
  "import and export: merge, replace and the .env layout",
  {
    tag: "@secrets",
    annotation: about(
      "A merge import previews then applies; a replace needs a preview revision and deletes what's missing; a stale revision is 409; export returns the values and the stored .env layout.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const kept = await app.make.secret(env, "KEPT");
    const old = await app.make.secret(env, "DROPPED");
    const [a, b] = [app.value(), app.value()];
    const layout = "# app settings\nKEPT=\nNEW_A=\n\n# later\nNEW_B=\n";
    const importPath = `/environments/${env.id}/secrets/import`;
    const preview = await step(
      "POST …/secrets/import as a merge dry run",
      async () => {
        const result = expectOk(
          await app.api.post(importPath, {
            mode: "merge",
            dryRun: true,
            entries: [
              { key: "KEPT", value: kept },
              { key: "NEW_A", value: a },
            ],
          }),
        );
        expect(result).toMatchObject({
          dryRun: true,
          addedKeys: ["NEW_A"],
          unchangedKeys: ["KEPT"],
          updatedKeys: [],
          deletedKeys: [],
        });
        return result;
      },
    );
    await step("The dry run changed nothing", async () => {
      const keys = (
        await app.api.must(
          "GET",
          `/environments/${env.id}/secrets`,
          undefined,
          {
            record: false,
          },
        )
      ).map((s: { key: string }) => s.key);
      expect(keys.sort()).toEqual(["DROPPED", "KEPT"]);
    });
    await step(
      "POST …/secrets/import merge applies it with the layout",
      async () => {
        const result = expectOk(
          await app.api.post(importPath, {
            mode: "merge",
            entries: [
              { key: "KEPT", value: kept },
              { key: "NEW_A", value: a },
            ],
            envLayout: layout,
            expectedRevision: preview.revision,
          }),
        );
        expect(result).toMatchObject({ dryRun: false, addedKeys: ["NEW_A"] });
      },
    );
    await step("GET …/secrets/layout returns the stored layout", async () => {
      expect(
        expectOk(await app.api.get(`/environments/${env.id}/secrets/layout`))
          .layout,
      ).toBe(layout);
    });
    await step("A replace import without a preview is 409", async () => {
      expectError(
        await app.api.post(importPath, {
          mode: "replace",
          entries: [{ key: "NEW_B", value: b }],
        }),
        409,
        "IMPORT_PREVIEW_REQUIRED",
      );
    });
    await step("A replace with a stale revision is 409", async () => {
      expectError(
        await app.api.post(importPath, {
          mode: "replace",
          entries: [{ key: "NEW_B", value: b }],
          expectedRevision: preview.revision,
        }),
        409,
        "IMPORT_PREVIEW_STALE",
      );
    });
    await step(
      "A replace previews, then applies with the revision",
      async () => {
        const entries = [
          { key: "KEPT", value: kept },
          { key: "NEW_A", value: a },
          { key: "NEW_B", value: b },
        ];
        const dry = expectOk(
          await app.api.post(importPath, {
            mode: "replace",
            dryRun: true,
            entries,
          }),
        );
        expect(dry.deletedKeys).toEqual(["DROPPED"]);
        expect(dry.addedKeys).toEqual(["NEW_B"]);
        const applied = expectOk(
          await app.api.post(importPath, {
            mode: "replace",
            entries,
            expectedRevision: dry.revision,
          }),
        );
        expect(applied.deletedKeys).toEqual(["DROPPED"]);
      },
    );
    await step("An import with a duplicate key is 422", async () => {
      expectError(
        await app.api.post(importPath, {
          mode: "merge",
          entries: [
            { key: "DUP", value: a },
            { key: "DUP", value: b },
          ],
        }),
        422,
        "IMPORT_DUPLICATE_KEY",
      );
    });
    await step(
      "POST …/secrets/export returns every value and the layout",
      async () => {
        const exported = expectOk(
          await app.api.post(`/environments/${env.id}/secrets/export`),
        );
        const values = Object.fromEntries(
          exported.entries.map((e: { key: string; value: string }) => [
            e.key,
            e.value,
          ]),
        );
        expect(values).toEqual({ KEPT: kept, NEW_A: a, NEW_B: b });
        expect(values).not.toHaveProperty("DROPPED");
        expect(exported.envLayout).toBe(layout);
        expect(exported.revision).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(exported)).not.toContain(old);
      },
    );
    await step("Export without a session is 401", async () => {
      expectError(
        await (
          await app.anonymousApi()
        ).post(`/environments/${env.id}/secrets/export`),
        401,
      );
    });
  },
);

test(
  "history keeps DOPBASE_SECRET_HISTORY_VERSIONS versions",
  {
    tag: "@secrets",
    annotation: about(
      "With DOPBASE_SECRET_HISTORY_VERSIONS=3, five writes keep the values of the last three versions; older ones stay in history but are gone (410) for reveal and rollback.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const values: string[] = [];
    for (let i = 0; i < 5; i++)
      values.push(await app.make.secret(env, "ROTATED"));
    const path = secretPath(env.id, "ROTATED");
    await step(
      "GET …/ROTATED/versions: only 5, 4 and 3 are restorable",
      async () => {
        const page = expectOk(await app.api.get(`${path}/versions`));
        // Pruned versions keep their history row, without a value.
        expect(
          page.items.map((v: { version: number; restorable: boolean }) => [
            v.version,
            v.restorable,
          ]),
        ).toEqual([
          [5, true],
          [4, true],
          [3, true],
          [2, false],
          [1, false],
        ]);
        expect(page.retainedVersions).toBe(HISTORY);
      },
    );
    await step("Version 3 still reveals", async () => {
      expect(
        expectOk(await app.api.post(`${path}/versions/3/reveal`)).value,
      ).toBe(values[2]);
    });
    await step("Version 1 is pruned: reveal is 410", async () => {
      expectError(
        await app.api.post(`${path}/versions/1/reveal`),
        410,
        "SECRET_VERSION_EXPIRED",
      );
    });
    await step("Rolling back to pruned version 2 is 410", async () => {
      expectError(
        await app.api.post(`${path}/rollback`, { version: 2 }),
        410,
        "SECRET_VERSION_EXPIRED",
      );
    });
  },
);
