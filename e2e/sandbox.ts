// Starts a Dopbase server with sample data for testing by hand, the way the
// e2e harness starts one for a spec file: the release binary, a temp data
// dir and HOME, root claimed. Prints the Admin UI address, a one-time
// sign-in link and the env to point a CLI at it, then runs until Ctrl+C.
//
//   bun run test:e2e:sandbox [--port N] [--empty] [--keep] [--skip-build]
//   bun run test:e2e:sandbox --from <dir>    a server E2E_KEEP kept
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureBinary } from "./binary.ts";
import {
  ROOT_EMAIL,
  ROOT_PASSWORD,
  binaryPath,
  mintLaunchLink,
  startServerIn,
  type Server,
} from "./harness/server.ts";

type Args = {
  port?: number;
  empty: boolean;
  keep: boolean;
  skipBuild: boolean;
  from?: string;
};

const USAGE = `Starts a Dopbase server with sample data for testing by hand.

  bun run test:e2e:sandbox [options]

  --port <n>      Listen on this port instead of a free one.
  --empty         Root only: no projects, secrets or people.
  --keep          Keep the server's files when you stop it.
  --from <dir>    Start a server E2E_KEEP kept after a failed test (its files stay).
  --skip-build    Use the release binary as it is.
  --help, -h      This text.`;

function parseArgs(argv: string[]): Args {
  const args: Args = { empty: false, keep: false, skipBuild: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--port") args.port = Number(argv[++i]);
    else if (arg === "--empty") args.empty = true;
    else if (arg === "--keep") args.keep = true;
    else if (arg === "--skip-build") args.skipBuild = true;
    else if (arg === "--from") args.from = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`Unknown option ${arg}\n\n${USAGE}`);
      process.exit(2);
    }
  }
  if (args.port !== undefined && !Number.isInteger(args.port)) {
    console.error("--port takes a number");
    process.exit(2);
  }
  return args;
}

/** A browser session as `email`, enough for the setup calls below. */
async function session(url: string, email: string, password: string) {
  const login = await fetch(`${url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, sessionKind: "browser" }),
  });
  const body = (await login.json().catch(() => ({}))) as any;
  if (!login.ok)
    throw new Error(`Signing in ${email} failed: ${JSON.stringify(body)}`);
  const headers = {
    "content-type": "application/json",
    "x-dopbase-csrf": body.data.csrfToken as string,
    cookie: login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  };
  return async function call<T = any>(
    method: string,
    path: string,
    payload?: unknown,
  ): Promise<T> {
    const response = await fetch(`${url}/api/v1${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const parsed = (await response.json().catch(() => ({}))) as any;
    if (!response.ok)
      throw new Error(
        `${method} ${path} answered ${response.status}: ${parsed?.message ?? JSON.stringify(parsed)}`,
      );
    return parsed.data as T;
  };
}
type Call = Awaited<ReturnType<typeof session>>;

const fake = (prefix: string) => `${prefix}${randomBytes(12).toString("hex")}`;

// Two projects shaped like a real team's, so every page has something on it.
const PROJECTS = [
  {
    name: "storefront",
    environments: [
      { name: "development", protected: false },
      { name: "staging", protected: false },
      { name: "production", protected: true },
    ],
    secrets: (env: string) => ({
      DATABASE_URL: `postgres://storefront:${fake("")}@db.internal:5432/storefront_${env}`,
      STRIPE_SECRET_KEY: fake("sk_test_"),
      SESSION_SECRET: fake(""),
    }),
  },
  {
    name: "billing-api",
    environments: [
      { name: "development", protected: false },
      { name: "production", protected: true },
    ],
    secrets: () => ({
      API_KEY: fake("bill_"),
      WEBHOOK_SECRET: fake("whsec_"),
    }),
  },
];

type Person = { email: string; password: string; role: string };

async function seed(
  call: Call,
): Promise<{ notes: string[]; people: Person[] }> {
  const notes: string[] = [];
  let environments = 0;
  let secrets = 0;
  const envIds = new Map<string, string>();
  for (const project of PROJECTS) {
    await call("POST", "/projects", { name: project.name });
    for (const env of project.environments) {
      const created = await call(
        "POST",
        `/projects/${project.name}/environments`,
        env,
      );
      environments++;
      envIds.set(`${project.name}/${env.name}`, created.id);
      for (const [key, value] of Object.entries(project.secrets(env.name))) {
        try {
          await call("PUT", `/environments/${created.id}/secrets/${key}`, {
            value,
          });
          secrets++;
        } catch (error) {
          notes.push(`Left ${project.name}/${env.name} ${key} empty: ${error}`);
        }
      }
    }
  }

  const roles = await call<{ id: string; name: string }[]>("GET", "/roles");
  const roleId = (name: string) =>
    roles.find((r) => r.name.toLowerCase() === name.toLowerCase())?.id;
  const people: Person[] = [];
  for (const person of [
    { email: "maya@dopbase.com", role: "Member" },
    { email: "sam@dopbase.com", role: "Admin" },
  ]) {
    const id = roleId(person.role);
    if (!id) {
      notes.push(`No ${person.role} role, so ${person.email} wasn't added.`);
      continue;
    }
    const password = fake("pw-");
    const user = await call("POST", "/users", {
      email: person.email,
      password,
      roleId: id,
    });
    people.push({ ...person, password });
    // Maya can change development and only read the rest of storefront.
    if (person.role === "Member") {
      await call("PUT", "/grants", {
        principalType: "user",
        principalId: user.id,
        level: "read",
        scopeType: "project",
        scope: "storefront",
      });
      await call("PUT", "/grants", {
        principalType: "user",
        principalId: user.id,
        level: "write",
        scopeType: "environment",
        scope: envIds.get("storefront/development"),
      });
    }
  }
  notes.unshift(
    `${PROJECTS.length} projects, ${environments} environments, ${secrets} secrets, ${people.length} people`,
  );
  return { notes, people };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.skipBuild) ensureBinary(true);

  let root: string;
  let env: Record<string, string> = { DOPBASE_RBAC: "true" };
  if (args.from) {
    root = resolve(args.from);
    if (!existsSync(join(root, "data"))) {
      console.error(`${root} has no data/ folder; is it a kept e2e server?`);
      process.exit(1);
    }
    const saved = join(root, "sandbox.json");
    if (existsSync(saved))
      env = JSON.parse(readFileSync(saved, "utf8")).env ?? {};
  } else {
    root = await mkdtemp(join(tmpdir(), "dopbase-sandbox-"));
  }
  const ownsFiles = !args.from && !args.keep;

  console.log(
    args.from ? `Starting the server in ${root}…` : "Starting a server…",
  );
  let server: Server;
  try {
    server = await startServerIn(root, {
      env,
      port: args.port,
      claimRoot: !args.from,
    });
  } catch (error) {
    if (ownsFiles) await rm(root, { recursive: true, force: true });
    throw error;
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\nStopping…");
    await server.halt();
    if (ownsFiles) await rm(root, { recursive: true, force: true });
    else console.log(`The files are still in ${root}`);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const lines: string[] = [];
  const row = (label: string, value: string) =>
    lines.push(`  ${label.padEnd(12)}${value}`);
  let token: string | undefined;
  let tokenOwner: string | undefined;
  let people: Person[] = [];
  const notes: string[] = [];
  try {
    const call = await session(server.url, ROOT_EMAIL, ROOT_PASSWORD);
    if (!args.from && !args.empty) {
      const seeded = await seed(call);
      people = seeded.people;
      notes.push(...seeded.notes);
    }
    // A personal token signs the CLI in without the browser login flow.
    // Root can't hold one, so it belongs to the sample Admin, whose tokens
    // go up to write.
    const admin = people.find((p) => p.role === "Admin");
    if (admin) {
      try {
        const asAdmin = await session(server.url, admin.email, admin.password);
        const created = await asAdmin("POST", "/users/me/tokens", {
          name: "sandbox-cli",
          level: "write",
          scopeType: "all",
          scope: null,
        });
        token = created.plaintextToken;
        tokenOwner = admin.email;
      } catch (error) {
        notes.push(`No personal token for the CLI: ${error}`);
      }
    }
    if (!token)
      notes.push(
        "Sign the CLI in with dopbase login --browser and approve it in the Admin UI.",
      );
  } catch (error) {
    notes.push(`Setup stopped early: ${error}`);
  }

  const bin = binaryPath();
  row("Admin UI", server.url);
  row("Sign in", `${server.url}${await mintLaunchLink(server.dataDir)}`);
  row("", "works once, for 60 seconds");
  row("Root", `${ROOT_EMAIL} / ${ROOT_PASSWORD}`);
  for (const p of people) row(p.role, `${p.email} / ${p.password}`);
  row("Files", root);
  row("Server log", server.logPath);

  const cli = [
    `export DOPBASE_URL=${server.url}`,
    `export DOPBASE_DATA_DIR=${join(root, "client-sandbox")}`,
    ...(token ? [`export DOPBASE_TOKEN=${token}`] : []),
    `alias dopbase=${bin}`,
    "dopbase project list",
  ];
  if (!args.empty && !args.from)
    cli.push("dopbase secret list storefront/development");

  console.log(
    [
      "",
      "Dopbase sandbox is running.",
      "",
      ...lines,
      "",
      tokenOwner
        ? `To use the CLI as ${tokenOwner}, paste this into another terminal:`
        : "To use the CLI, paste this into another terminal:",
      ...cli.map((l) => `  ${l}`),
      "",
      "For a fresh sign-in link:",
      `  ${bin} --data-dir ${server.dataDir} admin passcode ${ROOT_EMAIL}`,
      ...(notes.length ? ["", ...notes.map((n) => `  ${n}`)] : []),
      "",
      ownsFiles
        ? "Ctrl+C stops the server and deletes its files. Start with --keep to keep them."
        : "Ctrl+C stops the server. Its files stay.",
    ].join("\n"),
  );
  // Keep running until Ctrl+C.
  await new Promise(() => {});
}

await main();
