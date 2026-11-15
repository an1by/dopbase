import {
  about,
  expect,
  ROOT,
  step,
  test,
  useServer,
} from "../harness/index.ts";
import {
  expectError,
  expectOk,
  freshSession,
  masterKeyHex,
  multipart,
  QUIET,
  readBackupFile,
} from "./support.ts";

const app = useServer({ env: { DOPBASE_RBAC: "true" } });

test(
  "backup list, create, download and delete",
  {
    tag: "@backup",
    annotation: about(
      "Root takes a named backup, sees it listed, downloads it whole, and deletes it; duplicate and invalid names are refused and unknown keys are 404.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    await app.make.secret(env, "API_KEY");
    const name = app.uniq("nightly");
    const backup = await step(`POST /backups ${name}`, async () => {
      const created = expectOk(await app.api.post("/backups", { name }), 201);
      expect(created.key).toBe(`${name}.dop`);
      expect(created.size).toBeGreaterThan(0);
      return created;
    });
    await step("POST /backups with the same name is 409", async () => {
      expectError(
        await app.api.post("/backups", { name }),
        409,
        "BACKUP_EXISTS",
      );
    });
    await step("POST /backups with an invalid name is 400", async () => {
      expectError(
        await app.api.post("/backups", { name: "../escape" }),
        400,
        "BACKUP_NAME_INVALID",
      );
    });
    await step("GET /backups lists it", async () => {
      const list = expectOk(await app.api.get("/backups"));
      expect(list).toContainEqual(
        expect.objectContaining({ key: backup.key, size: backup.size }),
      );
    });
    await step("GET /backups/{key} downloads the whole file", async () => {
      const download = await app.api.get(`/backups/${backup.key}`);
      expect(download.status).toBe(200);
      expect(download.headers["content-type"]).toBe("application/octet-stream");
      expect(download.headers["content-length"]).toBe(String(backup.size));
      expect(download.headers["content-disposition"]).toContain(backup.key);
    });
    await step("DELETE /backups/{key}", async () => {
      expectOk(await app.api.delete(`/backups/${backup.key}`));
    });
    await step(
      "The deleted backup is 404 to download, restore and delete",
      async () => {
        expectError(
          await app.api.get(`/backups/${backup.key}`),
          404,
          "BACKUP_NOT_FOUND",
        );
        expectError(
          await app.api.post(`/backups/${backup.key}/restore`),
          404,
          "BACKUP_NOT_FOUND",
        );
        expectError(
          await app.api.delete(`/backups/${backup.key}`),
          404,
          "BACKUP_NOT_FOUND",
        );
      },
    );
  },
);

test(
  "backups and the master key are root's",
  {
    tag: "@backup",
    annotation: about(
      "Without a session backup routes are 401; an Admin can't list, take or download backups or the master key (403); root downloads the 32-byte master key.",
    ),
  },
  async () => {
    const admin = await app.apiAs(await app.make.user({ role: "Admin" }));
    const anonymous = await app.anonymousApi();
    await step("Backup routes without a session are 401", async () => {
      expectError(await anonymous.get("/backups"), 401);
      expectError(await anonymous.post("/backups", { name: "x" }), 401);
      expectError(await anonymous.get("/backups/master-key"), 401);
    });
    await step("An Admin gets 403 for backups and the master key", async () => {
      expect((await admin.get("/backups")).status).toBe(403);
      expect(
        (await admin.post("/backups", { name: app.uniq("admin") })).status,
      ).toBe(403);
      expect((await admin.get("/backups/master-key")).status).toBe(403);
    });
    await step(
      "GET /backups/master-key as root is the 32-byte key",
      async () => {
        const key = await app.api.get("/backups/master-key");
        expect(key.status).toBe(200);
        expect(key.headers["content-type"]).toBe("application/octet-stream");
        expect(key.headers["content-length"]).toBe("32");
        expect(key.headers["content-disposition"]).toContain("master.key");
      },
    );
    await step("Downloading the key is audited", async () => {
      const events = await app.api.must(
        "GET",
        "/audit-events?action=master_key.downloaded",
        undefined,
        QUIET,
      );
      expect(events.items.length).toBeGreaterThan(0);
    });
  },
);

test(
  "upload a backup and restore it",
  {
    tag: "@backup",
    annotation: about(
      "A backup file uploaded under a new name (with the master key) restores the instance to how it was when it was taken: a secret changed afterwards gets its old value back.",
    ),
  },
  async () => {
    // Restoring replaces the whole instance, so this test runs last.
    const env = await app.make.environment();
    const before = await app.make.secret(env, "API_KEY");
    const taken = await app.api.must(
      "POST",
      "/backups",
      { name: app.uniq("before") },
      QUIET,
    );
    const file = await readBackupFile(app, taken.key);
    const key = await masterKeyHex(app.dataDir);
    const uploadName = `${app.uniq("uploaded")}.dop`;
    await step(
      "POST /backups/upload with a file that isn't a backup is 400",
      async () => {
        const form = multipart({
          file: {
            filename: "junk.dop",
            data: Buffer.from("definitely not a backup"),
          },
        });
        const result = await app.api.send(
          "POST",
          "/backups/upload",
          form.body,
          {
            headers: form.headers,
          },
        );
        expect(result.status).toBe(400);
      },
    );
    await step("POST /backups/upload without a file is 400", async () => {
      const form = multipart({ key });
      expectError(
        await app.api.send("POST", "/backups/upload", form.body, {
          headers: form.headers,
        }),
        400,
        "BACKUP_FILE_MISSING",
      );
    });
    await step(
      `POST /backups/upload ${uploadName} with the master key`,
      async () => {
        const form = multipart({
          file: { filename: uploadName, data: file },
          key,
        });
        const uploaded = expectOk(
          await app.api.send("POST", "/backups/upload", form.body, {
            headers: form.headers,
          }),
          201,
        );
        expect(uploaded.key).toBe(uploadName);
        expect(uploaded.size).toBe(file.length);
      },
    );
    const after = await app.make.secret(env, "API_KEY");
    expect(after).not.toBe(before);
    await step(`POST /backups/${uploadName}/restore`, async () => {
      expectOk(await app.api.post(`/backups/${uploadName}/restore`, {}));
    });
    await step("API_KEY has its value from before the backup", async () => {
      // A restore replaces sessions too, so sign in again.
      const root = await freshSession(app, ROOT);
      const revealed = await root.must(
        "POST",
        `/environments/${env.id}/secrets/API_KEY/reveal`,
        {},
        QUIET,
      );
      expect(revealed.value).toBe(before);
      await root.dispose();
    });
  },
);
