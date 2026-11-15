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
import {
  expectError,
  expectOk,
  freshSession,
  personalToken,
} from "./support.ts";

// People need RBAC; everything else here works on a default server.
const app = useServer({ env: { DOPBASE_RBAC: "true" } });

/** A fresh, unsigned-in client of this file's server. */
function newClient(): Promise<ApiClient> {
  // A new context each time, so cookies never leak between sessions.
  return ApiClient.create(app.url, "fresh", []);
}

test(
  "login works and a wrong password is refused",
  {
    tag: "@auth",
    annotation: about(
      "POST /auth/login opens a browser session with a cookie and CSRF token, a CLI session with a bearer token, and refuses a wrong password or a malformed body.",
    ),
  },
  async () => {
    const api = await newClient();
    await step("POST /auth/login as a browser session", async () => {
      const login = await api.post("/auth/login", {
        email: ROOT_EMAIL,
        password: ROOT_PASSWORD,
        sessionKind: "browser",
      });
      const session = expectOk(login);
      expect(session).toMatchObject({ email: ROOT_EMAIL, role: "root" });
      expect(session.csrfToken).toMatch(/^csrf_/);
      expect(login.cookies.length).toBeGreaterThan(0);
    });
    await step(
      "POST /auth/login as a CLI session returns a token",
      async () => {
        const session = expectOk(
          await api.post("/auth/login", {
            email: ROOT_EMAIL,
            password: ROOT_PASSWORD,
            sessionKind: "cli",
          }),
        );
        expect(session.sessionKind).toBe("cli");
        expect(session.token).toMatch(/^dbc_/);
        expect(session.csrfToken).toBeNull();
      },
    );
    await step("POST /auth/login with a wrong password is 401", async () => {
      expectError(
        await api.post("/auth/login", {
          email: ROOT_EMAIL,
          password: "not-the-password-at-all",
          sessionKind: "browser",
        }),
        401,
        "AUTHENTICATION_INVALID",
      );
    });
    await step(
      "POST /auth/login for an unknown email is the same 401",
      async () => {
        expectError(
          await api.post("/auth/login", {
            email: "nobody@dopbase.com",
            password: ROOT_PASSWORD,
            sessionKind: "browser",
          }),
          401,
          "AUTHENTICATION_INVALID",
        );
      },
    );
    await step("POST /auth/login without a password is 422", async () => {
      const missing = await api.post("/auth/login", { email: ROOT_EMAIL });
      expect(missing.status).toBe(422);
    });
    await api.dispose();
  },
);

test(
  "session, logout, then the session is gone",
  {
    tag: "@auth",
    annotation: about(
      "GET /auth/session describes the signed-in account; after POST /auth/logout the same cookie gets 401, and logout needs the CSRF header.",
    ),
  },
  async () => {
    const user = await app.make.user();
    const session = await freshSession(app, user);
    await step("GET /auth/session shows the account", async () => {
      const current = expectOk(await session.get("/auth/session"));
      expect(current).toMatchObject({
        email: user.email,
        roleName: "Member",
        sessionKind: "browser",
        recentAuthentication: true,
      });
    });
    await step("GET /auth/session without a session is 401", async () => {
      expectError(
        await (await app.anonymousApi()).get("/auth/session"),
        401,
        "AUTHENTICATION_REQUIRED",
      );
    });
    await step("POST /auth/logout without the CSRF header is 403", async () => {
      const result = await session.send(
        "POST",
        "/auth/logout",
        {},
        {
          headers: { "x-dopbase-csrf": "" },
        },
      );
      expect(result.status).toBe(403);
    });
    await step("POST /auth/logout", async () => {
      expectOk(await session.post("/auth/logout"));
    });
    await step("GET /auth/session with the old cookie is 401", async () => {
      expectError(await session.get("/auth/session"), 401);
    });
    await session.dispose();
  },
);

test(
  "reauthenticate and change password",
  {
    tag: "@auth",
    annotation: about(
      "Reauthenticating checks the password; changing it ends every session and personal token, the old password stops working and the new one signs in.",
    ),
  },
  async () => {
    const user = await app.make.user();
    const session = await freshSession(app, user);
    const token = await personalToken(app, { id: user.id }, { as: session });
    const newPassword = `new-${user.password}`;
    await step(
      "POST /auth/reauthenticate with a wrong password is 401",
      async () => {
        expectError(
          await session.post("/auth/reauthenticate", {
            password: "definitely-wrong-password",
          }),
          401,
          "AUTHENTICATION_INVALID",
        );
      },
    );
    await step("POST /auth/reauthenticate with the password", async () => {
      expectOk(
        await session.post("/auth/reauthenticate", { password: user.password }),
      );
      expect(
        expectOk(await session.get("/auth/session")).recentAuthentication,
      ).toBe(true);
    });
    await step(
      "POST /auth/change-password with a wrong current password is 401",
      async () => {
        expectError(
          await session.post("/auth/change-password", {
            currentPassword: "definitely-wrong-password",
            newPassword,
          }),
          401,
        );
      },
    );
    await step(
      "POST /auth/change-password with a short new one is 422",
      async () => {
        expectError(
          await session.post("/auth/change-password", {
            currentPassword: user.password,
            newPassword: "short",
          }),
          422,
          "PASSWORD_TOO_SHORT",
        );
      },
    );
    await step("POST /auth/change-password", async () => {
      expectOk(
        await session.post("/auth/change-password", {
          currentPassword: user.password,
          newPassword,
        }),
      );
    });
    await step("The personal token made before the change is 401", async () => {
      const api = await app.apiWithToken(token.token);
      expectError(await api.get("/projects"), 401);
      await api.dispose();
    });
    await step("The old password is refused, the new one works", async () => {
      const api = await newClient();
      expectError(
        await api.post("/auth/login", {
          email: user.email,
          password: user.password,
          sessionKind: "browser",
        }),
        401,
        "AUTHENTICATION_INVALID",
      );
      expectOk(
        await api.post("/auth/login", {
          email: user.email,
          password: newPassword,
          sessionKind: "browser",
        }),
      );
      await api.dispose();
    });
    await session.dispose();
  },
);

test(
  "auth methods reflect the server config",
  {
    tag: "@auth",
    annotation: about(
      "GET /auth/methods is public and, with no SSO provider, offers the password form and browser CLI login only.",
    ),
  },
  async () => {
    await step("GET /auth/methods without a session", async () => {
      const methods = expectOk(
        await (await app.anonymousApi()).get("/auth/methods"),
      );
      expect(methods).toEqual({
        password: true,
        passwordForm: true,
        sso: null,
        cliBrowser: true,
      });
    });
  },
);

test(
  "a launch passcode works once and a replay is refused",
  {
    tag: "@auth",
    annotation: about(
      "A passcode from `dopbase admin passcode` trades for a browser session once; the same passcode again, or a wrong one, is 401.",
    ),
  },
  async () => {
    const user = await app.make.user();
    const link = await app.launchLink(user.email);
    const fragment = new URLSearchParams(link.split("#")[1]);
    const identity = fragment.get("identity")!;
    const passcode = fragment.get("passcode")!;
    const api = await newClient();
    await step("POST /auth/launch with a wrong passcode is 401", async () => {
      expectError(
        await api.post("/auth/launch", { identity, passcode: "AAAA-AAAA" }),
        401,
        "PASSCODE_INVALID",
      );
    });
    await step("POST /auth/launch with the minted passcode", async () => {
      const launch = await api.post("/auth/launch", { identity, passcode });
      const session = expectOk(launch);
      expect(session.email).toBe(user.email);
      expect(session.csrfToken).toMatch(/^csrf_/);
      expect(launch.cookies.length).toBeGreaterThan(0);
    });
    await step(
      "POST /auth/launch with the same passcode again is 401",
      async () => {
        expectError(
          await api.post("/auth/launch", { identity, passcode }),
          401,
          "PASSCODE_INVALID",
        );
      },
    );
    await api.dispose();
  },
);

test(
  "CLI device flow: approve, deny and cancel",
  {
    tag: "@auth",
    annotation: about(
      "A CLI asks for a device code, a signed-in person inspects and approves it, and the CLI's poll returns a session; denied and cancelled codes never do.",
    ),
  },
  async () => {
    const cli = await newClient();
    const start = async () =>
      expectOk(
        await cli.post("/auth/cli/device", {
          hostname: "e2e-box",
          client: "dopbase e2e",
        }),
        201,
      );

    const device = await step(
      "POST /auth/cli/device starts a login",
      async () => {
        const started = await start();
        expect(started.deviceCode).toMatch(/^dbd_/);
        expect(started.userCode).toBeTruthy();
        expect(started.verificationUriComplete).toContain("/cli/approve?code=");
        return started;
      },
    );
    await step("POST /auth/cli/token is pending before approval", async () => {
      const poll = expectOk(
        await cli.post("/auth/cli/token", { deviceCode: device.deviceCode }),
      );
      expect(poll.status).toBe("pending");
      expect(poll.session).toBeNull();
    });
    await step("POST /auth/cli/inspect without a session is 401", async () => {
      expect(
        (await cli.post("/auth/cli/inspect", { userCode: device.userCode }))
          .status,
      ).toBe(401);
    });
    await step("POST /auth/cli/inspect shows the requesting host", async () => {
      const details = expectOk(
        await app.api.post("/auth/cli/inspect", { userCode: device.userCode }),
      );
      expect(details.hostname).toBe("e2e-box");
      expect(details.client).toBe("dopbase e2e");
    });
    await step(
      "POST /auth/cli/inspect with an unknown code is 404",
      async () => {
        expect(
          (await app.api.post("/auth/cli/inspect", { userCode: "ZZZZ-ZZZZ" }))
            .status,
        ).toBe(404);
      },
    );
    await step("POST /auth/cli/approve", async () => {
      expectOk(
        await app.api.post("/auth/cli/approve", { userCode: device.userCode }),
      );
    });
    const token = await step(
      "POST /auth/cli/token returns a CLI session",
      async () => {
        const poll = expectOk(
          await cli.post("/auth/cli/token", { deviceCode: device.deviceCode }),
        );
        expect(poll.status).toBe("approved");
        expect(poll.session).toMatchObject({
          email: ROOT_EMAIL,
          sessionKind: "cli",
        });
        return poll.session.token as string;
      },
    );
    await step(
      "The CLI session token works for GET /auth/session",
      async () => {
        const api = await app.apiWithToken(token);
        expect(expectOk(await api.get("/auth/session")).sessionKind).toBe(
          "cli",
        );
        await api.dispose();
      },
    );
    await step(
      "Polling the used code again is 400 DEVICE_CODE_INVALID",
      async () => {
        expectError(
          await cli.post("/auth/cli/token", { deviceCode: device.deviceCode }),
          400,
          "DEVICE_CODE_INVALID",
        );
      },
    );

    const denied = await start();
    await step("POST /auth/cli/deny", async () => {
      expectOk(
        await app.api.post("/auth/cli/deny", { userCode: denied.userCode }),
      );
    });
    await step(
      "The denied code's poll is 403 DEVICE_ACCESS_DENIED",
      async () => {
        expectError(
          await cli.post("/auth/cli/token", { deviceCode: denied.deviceCode }),
          403,
          "DEVICE_ACCESS_DENIED",
        );
      },
    );

    const cancelled = await start();
    await step("POST /auth/cli/cancel from the CLI", async () => {
      expectOk(
        await cli.post("/auth/cli/cancel", {
          deviceCode: cancelled.deviceCode,
        }),
      );
    });
    await step(
      "The cancelled code's poll is 400 DEVICE_CODE_INVALID",
      async () => {
        expectError(
          await cli.post("/auth/cli/token", {
            deviceCode: cancelled.deviceCode,
          }),
          400,
          "DEVICE_CODE_INVALID",
        );
      },
    );
    await step("Approving the cancelled code is 404", async () => {
      expect(
        (
          await app.api.post("/auth/cli/approve", {
            userCode: cancelled.userCode,
          })
        ).status,
      ).toBe(404);
    });
    await cli.dispose();
  },
);

test(
  "wrong passwords count down, then sign-in pauses",
  {
    tag: "@auth",
    annotation: about(
      "Each wrong password for an email counts toward a limit of five. Once three or fewer tries are left the message says how many; after the fifth miss, even the right password gets 429 RATE_LIMITED with a wait in minutes.",
    ),
  },
  async () => {
    // The limit is counted per email, so a person of its own keeps root
    // and the other tests here clear of it.
    const person = await app.make.user();
    const api = await newClient();
    const login = (password: string) =>
      api.post("/auth/login", {
        email: person.email,
        password,
        sessionKind: "browser",
      });
    const messages: string[] = [];
    await step("Five wrong passwords are each 401", async () => {
      for (let i = 0; i < 5; i++) {
        const result = await login("not-the-password-at-all");
        expectError(result, 401, "AUTHENTICATION_INVALID");
        messages.push(String(result.body?.error?.AUTHENTICATION_INVALID ?? ""));
      }
    });
    await step("The messages count down the tries left", async () => {
      expect(messages[0]).toBe("Email or password is wrong.");
      expect(messages[1]).toMatch(/3 more tries, then a 15-minute pause/);
      expect(messages[2]).toMatch(/2 more tries, then a 15-minute pause/);
      expect(messages[3]).toMatch(/1 more try, then a 15-minute pause/);
    });
    await step("The right password is now 429 with a wait", async () => {
      const result = await login(person.password);
      expectError(result, 429, "RATE_LIMITED");
      expect(String(result.body?.error?.RATE_LIMITED)).toMatch(
        /Wait \d+ minutes?, then try again/,
      );
    });
    await api.dispose();
  },
);

test(
  "wrong passwords sent at once can't get past the limit",
  {
    tag: "@auth",
    annotation: about(
      "Ten wrong passwords sent together for one email: at most five are checked (401) and the rest are refused with 429 RATE_LIMITED, so parallel guesses get no extra tries. The right password is refused afterwards.",
    ),
  },
  async () => {
    const person = await app.make.user();
    const clients = await Promise.all(
      Array.from({ length: 10 }, () => newClient()),
    );
    const results = await step(
      "POST /auth/login ten times at once with wrong passwords",
      async () =>
        Promise.all(
          clients.map((client, i) =>
            client.post("/auth/login", {
              email: person.email,
              password: `wrong-password-number-${i}`,
              sessionKind: "browser",
            }),
          ),
        ),
    );
    await step("No more than five were checked", async () => {
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
      expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(
        5,
      );
    });
    await step("The right password is refused afterwards", async () => {
      expectError(
        await clients[0]!.post("/auth/login", {
          email: person.email,
          password: person.password,
          sessionKind: "browser",
        }),
        429,
        "RATE_LIMITED",
      );
    });
    await Promise.all(clients.map((client) => client.dispose()));
  },
);
