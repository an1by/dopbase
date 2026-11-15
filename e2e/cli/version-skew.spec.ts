import { printVar, tempDir } from "../harness/helpers.ts";
import {
  about,
  expect,
  step,
  test,
  useServer,
  type Environment,
} from "../harness/index.ts";
import { VersionProxy } from "./support.ts";

const app = useServer();

const WARNING = "Warning: The server runs Dopbase";

/** The version the test server reports on /health. */
async function serverVersion(): Promise<string> {
  const api = await app.anonymousApi();
  const health = await api.must("GET", "/health");
  return health.version;
}

/** `version` with its minor or patch part bumped by one. */
function bump(version: string, part: "minor" | "patch"): string {
  const [major, minor, patch] = version.split(".").map(Number);
  return part === "minor"
    ? `${major}.${minor! + 1}.0`
    : `${major}.${minor}.${patch! + 1}`;
}

/** A runner token for `env`, made with `dopbase token create`. */
async function runnerToken(env: Environment): Promise<string> {
  const created = await app
    .cli(["--json", "token", "create", env.ref, "--name", app.uniq("skew")])
    .json();
  return created.plaintextToken;
}

/**
 * `dopbase run <ref>` through `proxy` with a runner token, printing `key`
 * from the child.
 */
async function runThrough(
  proxy: VersionProxy,
  env: Environment,
  token: string,
  key: string,
  extra: Record<string, string> = {},
) {
  return app
    .cliRaw(["run", env.ref, "--", ...printVar(key)], {
      env: {
        HOME: app.server.root,
        DOPBASE_URL: proxy.url,
        DOPBASE_TOKEN: token,
        DOPBASE_DATA_DIR: await tempDir(app, "skew"),
        ...extra,
      },
    })
    .ok();
}

/** How many times the newer-server warning appears in `text`. */
function warnings(text: string): number {
  return text.split(WARNING).length - 1;
}

test(
  "the CLI names its version on every request",
  {
    tag: "@compat",
    annotation: about(
      "Every request `dopbase run` sends carries `User-Agent: dopbase/<version>`, the same version the server reports, so the server can tell which CLI is calling.",
    ),
  },
  async () => {
    const version = await serverVersion();
    const env = await app.make.environment();
    await app.make.secret(env, "API_KEY");
    const token = await runnerToken(env);
    const proxy = await VersionProxy.start(app.url);
    try {
      await step(`dopbase run ${env.ref} through a recording proxy`, async () =>
        runThrough(proxy, env, token, "API_KEY"),
      );
      await step(`Every request says dopbase/${version}`, async () => {
        expect(proxy.userAgents.length).toBeGreaterThan(0);
        for (const agent of proxy.userAgents)
          expect(agent).toBe(`dopbase/${version}`);
      });
    } finally {
      await proxy.close();
    }
  },
);

test(
  "the CLI warns once when the server is a minor release ahead",
  {
    tag: "@compat",
    annotation: about(
      "When responses say the server runs the next minor release, `dopbase run` still runs the command and prints one short warning on stderr, however many requests it made.",
    ),
  },
  async () => {
    const version = await serverVersion();
    const ahead = bump(version, "minor");
    const env = await app.make.environment();
    const value = await app.make.secret(env, "API_KEY");
    const token = await runnerToken(env);
    const proxy = await VersionProxy.start(app.url);
    proxy.serverVersion = ahead;
    try {
      const result = await step(
        `dopbase run ${env.ref} against a server reporting ${ahead}`,
        async () => runThrough(proxy, env, token, "API_KEY"),
      );
      await step("The command still runs", async () => {
        expect(result.stdout).toBe(value);
      });
      await step("stderr has the warning exactly once", async () => {
        expect(warnings(result.stderr)).toBe(1);
        expect(result.stderr).toContain(
          `Warning: The server runs Dopbase ${ahead} and this CLI is ${version}. Run \`dopbase update\`.`,
        );
      });
    } finally {
      await proxy.close();
    }
  },
);

test(
  "the CLI stays quiet for a patch release, an older server, or when told to",
  {
    tag: "@compat",
    annotation: about(
      "No warning when the server is only a patch release ahead, when responses carry no version header (an older server), or when DOPBASE_VERSION_WARNING=false.",
    ),
  },
  async () => {
    const version = await serverVersion();
    const env = await app.make.environment();
    await app.make.secret(env, "API_KEY");
    const token = await runnerToken(env);
    const proxy = await VersionProxy.start(app.url);
    try {
      const cases: [string, string | null, Record<string, string>][] = [
        [
          `a server reporting ${bump(version, "patch")}`,
          bump(version, "patch"),
          {},
        ],
        ["a server with no version header", null, {}],
        [
          "DOPBASE_VERSION_WARNING=false and a minor release ahead",
          bump(version, "minor"),
          { DOPBASE_VERSION_WARNING: "false" },
        ],
      ];
      for (const [label, reported, extra] of cases) {
        proxy.serverVersion = reported;
        const result = await step(`dopbase run against ${label}`, async () =>
          runThrough(proxy, env, token, "API_KEY", extra),
        );
        await step(`No warning for ${label}`, async () => {
          expect(warnings(result.stderr)).toBe(0);
        });
      }
    } finally {
      await proxy.close();
    }
  },
);
