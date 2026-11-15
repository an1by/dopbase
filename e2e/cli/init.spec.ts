import { about, expect, step, test, useServer } from "../harness/index.ts";
import { injected, writeTemp } from "./support.ts";

const app = useServer();

test(
  "init creates a project, an environment and secrets from a .env file",
  {
    tag: "@init",
    annotation: about(
      "`init <project>/<env> --from .env` creates both and imports every line; `run` then sees the values.",
    ),
  },
  async () => {
    const project = app.uniq("shop");
    const apiKey = app.value();
    const dbUrl = app.value();
    const file = await writeTemp(
      app,
      ".env",
      `# shop settings\nAPI_KEY=${apiKey}\nDATABASE_URL=${dbUrl}\n`,
    );
    const result = await step(
      `dopbase --json init ${project}/dev --from .env`,
      async () =>
        app.cli(["--json", "init", `${project}/dev`, "--from", file]).json(),
    );
    await step(
      "It creates the project and environment with 2 secrets",
      async () => {
        expect(result.project.name).toBe(project);
        expect(result.environmentId).toMatch(/^env_/);
        expect(result.secretCount).toBe(2);
      },
    );
    await step("secret list shows both keys", async () => {
      const keys = await app
        .cli(["--json", "secret", "list", `${project}/dev`])
        .json<any[]>();
      expect(keys.map((s) => s.key).sort()).toEqual([
        "API_KEY",
        "DATABASE_URL",
      ]);
    });
    await step("dopbase run sees the imported values", async () => {
      expect(await injected(app, `${project}/dev`, "API_KEY")).toBe(apiKey);
      expect(await injected(app, `${project}/dev`, "DATABASE_URL")).toBe(dbUrl);
    });

    const other = app.uniq("blog");
    const yaml = await writeTemp(
      app,
      "secrets.yaml",
      `TOKEN: ${app.value()}\n`,
    );
    const human = await step(
      `dopbase init ${other}/prod --from secrets.yaml`,
      async () => app.cli(["init", `${other}/prod`, "--from", yaml]).stdout(),
    );
    await step("It says Initialized and counts 1 secret", async () => {
      expect(human).toContain(`Initialized ${other}/prod.`);
      expect(human).toMatch(/Secrets:\s+1/);
    });
  },
);

test(
  "init into an existing project is refused and changes nothing",
  {
    tag: "@init",
    annotation: about(
      "`init` only creates new projects: with a project that exists it fails with PROJECT_ALREADY_EXISTS and adds no environment or secret. (The catalog expected it to add the environment; the command's help says it creates a new project, and `env create` plus `import` cover that case.)",
    ),
  },
  async () => {
    const existing = await app.make.environment({ name: "dev" });
    const file = await writeTemp(app, ".env", `API_KEY=${app.value()}\n`);
    const ref = `${existing.projectName}/staging`;
    const result = await step(`dopbase init ${ref} --from .env`, async () =>
      app.cli(["init", ref, "--from", file]).fails(1),
    );
    await step("It says a project with this name already exists", async () => {
      expect(result.stderr).toContain("PROJECT_ALREADY_EXISTS");
    });
    await step("The project still has only dev, with no secrets", async () => {
      const list = await app
        .cli(["--json", "env", "list", existing.projectName])
        .json<any[]>();
      expect(list.map((e) => e.name)).toEqual(["dev"]);
      const keys = await app
        .cli(["--json", "secret", "list", existing.ref])
        .json<any[]>();
      expect(keys).toEqual([]);
    });
  },
);

test(
  "init reads stdin with --format and refuses bad input",
  {
    tag: "@init",
    annotation: about(
      "`init --from - --format json` reads secrets from stdin; stdin without --format, a missing file and a bare `init` without a terminal are refused.",
    ),
  },
  async () => {
    const project = app.uniq("api");
    const value = app.value();
    const piped = await step(
      `cat secrets.json | dopbase --json init ${project}/dev --from - --format json`,
      async () =>
        app
          .cli(
            [
              "--json",
              "init",
              `${project}/dev`,
              "--from",
              "-",
              "--format",
              "json",
            ],
            {
              stdin: JSON.stringify({ API_KEY: value }),
            },
          )
          .json(),
    );
    await step("It imports the key from stdin", async () => {
      expect(piped.secretCount).toBe(1);
      expect(await injected(app, `${project}/dev`, "API_KEY")).toBe(value);
    });
    const noFormat = await step(
      `dopbase init ${app.uniq("x")}/dev --from - without --format`,
      async () =>
        app
          .cli(["init", `${app.uniq("x")}/dev`, "--from", "-"], {
            stdin: "A=b\n",
          })
          .fails(1),
    );
    await step("stdin needs --format", async () => {
      expect(noFormat.stderr).toContain("--format");
    });
    const missing = await step(
      `dopbase init ${app.uniq("x")}/dev --from missing.env`,
      async () =>
        app
          .cli([
            "init",
            `${app.uniq("x")}/dev`,
            "--from",
            "/nonexistent/missing.env",
          ])
          .fails(1),
    );
    await step("A missing file is refused", async () => {
      expect(missing.stderr).toContain("missing.env");
    });
    const bare = await step(
      "dopbase init with no arguments and no terminal",
      async () => app.cli(["init"]).fails(1),
    );
    await step("Interactive init needs a terminal", async () => {
      expect(bare.stderr).toContain("interactive init requires a terminal");
    });
  },
);
