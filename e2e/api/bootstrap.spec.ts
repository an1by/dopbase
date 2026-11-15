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
import { startServer } from "../harness/server.ts";
import {
  backupFromAnotherServer,
  expectError,
  expectOk,
  multipart,
} from "./support.ts";

// The file's server starts unclaimed. The first four tests walk its first
// run in order, so they run serially: a claim can only happen once.
const app = useServer({ claimRoot: false });

test.describe.serial("first-run claim", () => {
  test(
    "status says setup is needed before the claim",
    {
      tag: "@smoke",
      annotation: about(
        "A fresh server answers bootstrap status setupRequired and refuses signed-in routes.",
      ),
    },
    async () => {
      const api = await app.anonymousApi();
      await step("GET /bootstrap/status is setupRequired", async () => {
        const status = expectOk(await api.get("/bootstrap/status"));
        expect(status.state).toBe("setupRequired");
      });
      await step("GET /projects without an account is 401", async () => {
        expectError(await api.get("/projects"), 401);
      });
    },
  );

  test(
    "a claim with a wrong setup token is refused",
    {
      tag: "@smoke",
      annotation: about(
        "POST /bootstrap/admin with a made-up setup token is 401 SETUP_TOKEN_INVALID and the server stays unclaimed.",
      ),
    },
    async () => {
      const api = await app.anonymousApi();
      await step(
        "POST /bootstrap/admin with a wrong token is 401",
        async () => {
          expectError(
            await api.post("/bootstrap/admin", {
              setupToken: "setup_not-the-real-token",
              email: ROOT_EMAIL,
              password: ROOT_PASSWORD,
            }),
            401,
            "SETUP_TOKEN_INVALID",
          );
        },
      );
      await step("Bootstrap status is still setupRequired", async () => {
        expect(expectOk(await api.get("/bootstrap/status")).state).toBe(
          "setupRequired",
        );
      });
    },
  );

  test(
    "the claim creates root and status turns ready",
    {
      tag: "@smoke",
      annotation: about(
        "With the printed setup token the claim creates root, returns a browser session, and the server reports ready.",
      ),
    },
    async () => {
      // Its own context: the claim sets a session cookie, which must not
      // stick to the shared anonymous client.
      const api = await ApiClient.create(app.url, "claim", []);
      await step(
        "POST /bootstrap/admin with a weak password is 422",
        async () => {
          const weak = await api.post("/bootstrap/admin", {
            setupToken: app.server.setupToken,
            email: ROOT_EMAIL,
            password: "short",
          });
          expect(weak.status).toBe(422);
        },
      );
      await step(
        "POST /bootstrap/admin with the setup token is 201",
        async () => {
          const claim = await api.post("/bootstrap/admin", {
            setupToken: app.server.setupToken,
            email: ROOT_EMAIL,
            password: ROOT_PASSWORD,
          });
          const root = expectOk(claim, 201);
          expect(root).toMatchObject({ email: ROOT_EMAIL, role: "root" });
          expect(root.csrfToken).toMatch(/^csrf_/);
          expect(claim.cookies.length).toBeGreaterThan(0);
        },
      );
      await step("GET /bootstrap/status is ready", async () => {
        expect(expectOk(await api.get("/bootstrap/status")).state).toBe(
          "ready",
        );
      });
      await step("Root signs in with the claimed password", async () => {
        const session = expectOk(await app.api.get("/auth/session"));
        expect(session).toMatchObject({ email: ROOT_EMAIL, role: "root" });
      });
      await api.dispose();
    },
  );

  test(
    "a second claim is refused",
    {
      tag: "@smoke",
      annotation: about(
        "Once root exists, another claim, even with the old setup token, is 409 BOOTSTRAP_CLOSED, and so is a bootstrap restore.",
      ),
    },
    async () => {
      const api = await app.anonymousApi();
      await step(
        "POST /bootstrap/admin again is 409 BOOTSTRAP_CLOSED",
        async () => {
          expectError(
            await api.post("/bootstrap/admin", {
              setupToken: app.server.setupToken,
              email: "second@dopbase.com",
              password: ROOT_PASSWORD,
            }),
            409,
            "BOOTSTRAP_CLOSED",
          );
        },
      );
      await step(
        "POST /bootstrap/restore is 409 BOOTSTRAP_CLOSED",
        async () => {
          const form = multipart({
            file: { filename: "x.dop", data: Buffer.from("not a backup") },
          });
          expectError(
            await api.send("POST", "/bootstrap/restore", form.body, {
              headers: {
                ...form.headers,
                "x-dopbase-setup-token": app.server.setupToken ?? "",
              },
            }),
            409,
            "BOOTSTRAP_CLOSED",
          );
        },
      );
    },
  );
});

test(
  "restore during bootstrap from a backup",
  {
    tag: "@smoke",
    annotation: about(
      "An unclaimed server takes a backup from another 0.2.0 server with its setup token and master key; afterwards that server's root, project and secret value are there.",
    ),
  },
  async () => {
    test.setTimeout(90_000);
    // This file's server was claimed above, so the restore goes to a second,
    // still unclaimed server that this test starts and stops.
    const backup = await step(
      "Back up a project with one secret on another server",
      () => backupFromAnotherServer(app.value()),
    );
    const target = await startServer({ claimRoot: false });
    const api = await ApiClient.create(target.url, "anonymous", []);
    try {
      await step(
        "POST /bootstrap/restore without the setup token is 400",
        async () => {
          const form = multipart({
            file: { filename: "seed.dop", data: backup.file },
            key: backup.masterKey,
          });
          expectError(
            await api.send("POST", "/bootstrap/restore", form.body, {
              headers: form.headers,
            }),
            400,
            "SETUP_TOKEN_REQUIRED",
          );
        },
      );
      await step(
        "POST /bootstrap/restore with a wrong setup token is 401",
        async () => {
          const form = multipart({
            file: { filename: "seed.dop", data: backup.file },
            key: backup.masterKey,
          });
          expectError(
            await api.send("POST", "/bootstrap/restore", form.body, {
              headers: {
                ...form.headers,
                "x-dopbase-setup-token": "setup_wrong",
              },
            }),
            401,
            "SETUP_TOKEN_INVALID",
          );
        },
      );
      await step(
        "POST /bootstrap/restore with token, file and key",
        async () => {
          const form = multipart({
            file: { filename: "seed.dop", data: backup.file },
            key: backup.masterKey,
          });
          const restored = expectOk(
            await api.send("POST", "/bootstrap/restore", form.body, {
              headers: {
                ...form.headers,
                "x-dopbase-setup-token": target.setupToken ?? "",
              },
            }),
          );
          expect(restored.restored).toBe(true);
        },
      );
      await step("Bootstrap status is ready", async () => {
        expect(expectOk(await api.get("/bootstrap/status")).state).toBe(
          "ready",
        );
      });
      await step(
        "The backup's root signs in and reads the secret",
        async () => {
          const login = expectOk(
            await api.send(
              "POST",
              "/auth/login",
              {
                email: ROOT_EMAIL,
                password: ROOT_PASSWORD,
                sessionKind: "cli",
              },
              { record: false },
            ),
          );
          const root = await ApiClient.create(target.url, "root", [], {
            authorization: `Bearer ${login.token}`,
          });
          try {
            const env = await root.must(
              "GET",
              `/environments/resolve?reference=${backup.project}/${backup.environment}`,
              undefined,
              { record: false },
            );
            const revealed = await root.must(
              "POST",
              `/environments/${env.id}/secrets/${backup.key}/reveal`,
              {},
              { record: false },
            );
            expect(revealed.value).toBe(backup.value);
          } finally {
            await root.dispose();
          }
        },
      );
    } finally {
      await api.dispose();
      await target.stop();
    }
  },
);
