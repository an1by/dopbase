import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { grant, tempDir } from "../harness/helpers.ts";
import {
  ROOT_EMAIL,
  about,
  expect,
  step,
  test,
  useServer,
} from "../harness/index.ts";
import { query, sql } from "./support.ts";

// The non-admin test needs a Member, so people management is on.
const app = useServer({ env: { DOPBASE_RBAC: "true" } });

test(
  "audit list shows one page, newest first",
  {
    tag: "@audit",
    annotation: about(
      "`audit list --limit` returns one page of events in descending sequence with a cursor, the table prints the next-page command on stderr, and filters narrow the page.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    await app
      .cli(["secret", "set", env.ref, "API_KEY", "--stdin"], {
        stdin: app.value(),
      })
      .ok();
    await app
      .cli(["secret", "set", env.ref, "API_KEY", "--stdin"], {
        stdin: app.value(),
      })
      .ok();
    const page = await step("dopbase --json audit list --limit 3", async () =>
      app.cli(["--json", "audit", "list", "--limit", "3"]).json(),
    );
    await step(
      "3 events come back newest first, with a next cursor",
      async () => {
        const seqs = page.items.map((i: any) => i.seq);
        expect(seqs).toHaveLength(3);
        expect([...seqs].sort((a: number, b: number) => b - a)).toEqual(seqs);
        expect(page.nextCursor).toBeTruthy();
        expect(page.items[0].action).toBe("secret.updated");
      },
    );
    const next = await step(
      "dopbase --json audit list --limit 3 --cursor <next>",
      async () =>
        app
          .cli([
            "--json",
            "audit",
            "list",
            "--limit",
            "3",
            "--cursor",
            page.nextCursor,
          ])
          .json(),
    );
    await step("The next page continues below the first", async () => {
      expect(next.items[0].seq).toBeLessThan(page.items[2].seq);
    });
    const table = await step("dopbase audit list --limit 2", async () =>
      app.cli(["audit", "list", "--limit", "2"]).ok(),
    );
    await step(
      "The table shows 2 events and the next-page command on stderr",
      async () => {
        expect(table.stdout).toMatch(/2 event\(s\)/);
        expect(table.stdout).toContain("secret.updated");
        expect(table.stderr).toContain(
          "More events match. Next page: dopbase audit list --limit 2 --cursor ",
        );
      },
    );
    const filtered = await step(
      `dopbase --json audit list --environment ${env.ref} --action secret.created`,
      async () =>
        app
          .cli([
            "--json",
            "audit",
            "list",
            "--environment",
            env.ref,
            "--action",
            "secret.created",
          ])
          .json(),
    );
    await step(
      "Only the one secret.created event for the environment matches",
      async () => {
        expect(filtered.items).toHaveLength(1);
        expect(filtered.items[0].environmentId).toBe(env.id);
      },
    );
  },
);

test(
  "audit verify passes on a clean log",
  {
    tag: "@audit",
    annotation: about(
      "`audit verify` reports an intact chain with the head sequence and hash, and `--anchor` with that head matches.",
    ),
  },
  async () => {
    await app.make.environment();
    const report = await step("dopbase --json audit verify", async () =>
      app.cli(["--json", "audit", "verify"]).json(),
    );
    await step("The chain is ok and nothing is broken", async () => {
      expect(report.ok).toBe(true);
      expect(report.broken).toBeNull();
      expect(report.records).toBeGreaterThan(0);
      expect(report.headHash).toMatch(/^[0-9a-f]{64}$/);
    });
    const human = await step("dopbase audit verify", async () =>
      app.cli(["audit", "verify"]).stdout(),
    );
    await step("It reads Chain: intact", async () => {
      expect(human).toMatch(/Chain:\s+intact/);
      expect(human).toMatch(/Records verified:\s+\d+/);
    });
    const anchored = await step(
      `dopbase --json audit verify --anchor ${report.headSeq}:<head hash>`,
      async () =>
        app
          .cli([
            "--json",
            "audit",
            "verify",
            "--anchor",
            `${report.headSeq}:${report.headHash}`,
          ])
          .json(),
    );
    await step("The anchor matches", async () => {
      expect(anchored.ok).toBe(true);
      expect(anchored.anchor.status).toBe("matched");
    });
  },
);

test(
  "audit export writes JSON lines to stdout and to a file",
  {
    tag: "@audit",
    annotation: about(
      "`audit export` prints one JSON object per line with the chain fields, and `--output` writes an owner-only file and reports the count.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    await app
      .cli(["secret", "set", env.ref, "API_KEY", "--stdin"], {
        stdin: app.value(),
      })
      .ok();
    const out = await step(
      `dopbase audit export --environment ${env.ref}`,
      async () =>
        app.cli(["audit", "export", "--environment", env.ref]).stdout(),
    );
    await step(
      "Each line is an event with seq, prevHash and recordHash",
      async () => {
        const lines = out.split("\n").map((line) => JSON.parse(line));
        expect(lines.length).toBeGreaterThan(0);
        for (const event of lines) {
          expect(event.environmentId).toBe(env.id);
          expect(event).toHaveProperty("seq");
          expect(event).toHaveProperty("prevHash");
          expect(event.recordHash).toMatch(/^[0-9a-f]{64}$/);
        }
      },
    );
    const path = join(await tempDir(app, "audit"), "audit.jsonl");
    const written = await step(
      "dopbase --json audit export --output audit.jsonl",
      async () =>
        app.cli(["--json", "audit", "export", "--output", path]).json(),
    );
    await step(
      "The file holds as many lines as it reports, owner-only",
      async () => {
        const lines = (await readFile(path, "utf8")).trim().split("\n");
        expect(written.exported).toBe(lines.length);
        expect((await stat(path)).mode & 0o077).toBe(0);
      },
    );
    const exists = await step(
      "dopbase audit export --output audit.jsonl again",
      async () => app.cli(["audit", "export", "--output", path]).fails(1),
    );
    await step("It won't overwrite without --force", async () => {
      expect(exists.stderr).toMatch(/exists|--force/);
    });
    const forced = await step(
      "dopbase audit export --output audit.jsonl --force --limit 2",
      async () =>
        app
          .cli(["audit", "export", "--output", path, "--force", "--limit", "2"])
          .stdout(),
    );
    await step("It says Exported 2 audit record(s)", async () => {
      expect(forced).toBe(`Exported 2 audit record(s) to ${path}.`);
    });
  },
);

test(
  "a non-admin is refused verify and sees only their own events",
  {
    tag: "@audit",
    annotation: about(
      "A Member running `audit verify` is refused, and `audit list` and `audit export` give them only their own actions, never root's.",
    ),
  },
  async () => {
    const member = await app.make.user({ role: "Member" });
    const rootProject = await app.make.project();
    const verify = await step("dopbase audit verify as a member", async () =>
      app.cli(["audit", "verify"], { as: member }).fails(1),
    );
    await step("It is refused", async () => {
      expect(verify.stderr).toMatch(/^Error: \w+: /);
    });
    const page = await step("dopbase --json audit list as a member", async () =>
      app.cli(["--json", "audit", "list"], { as: member }).json(),
    );
    await step("The page holds only the member's own events", async () => {
      expect(page.items.length).toBeGreaterThan(0);
      for (const event of page.items) expect(event.actorId).toBe(member.id);
    });
    const exported = await step("dopbase audit export as a member", async () =>
      app.cli(["audit", "export"], { as: member }).stdout(),
    );
    await step(
      "The export holds only the member's events, not root's project",
      async () => {
        const events = exported.split("\n").map((line) => JSON.parse(line));
        for (const event of events) expect(event.actorId).toBe(member.id);
        expect(exported).not.toContain(rootProject.id);
      },
    );
  },
);

test(
  "audit verify names the first broken event after tampering",
  {
    tag: "@audit",
    annotation: about(
      "Editing one audit row in the database makes `audit verify` exit 2 and name that sequence; putting the row back makes the chain intact again.",
    ),
  },
  async () => {
    await app.make.environment();
    const head = await app.cli(["--json", "audit", "verify"]).json();
    const target = Math.max(2, head.headSeq - 1);
    const [trigger] = await query<{ sql: string }>(
      app.dataDir,
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'audit_events_sealed_immutable'",
    );
    const [row] = await query<{ action: string }>(
      app.dataDir,
      "SELECT action FROM audit_events WHERE seq = ?",
      target,
    );
    try {
      await step(
        `Someone edits audit event ${target} in the database`,
        async () => {
          if (trigger)
            await sql(
              app.dataDir,
              "DROP TRIGGER audit_events_sealed_immutable",
            );
          await sql(
            app.dataDir,
            "UPDATE audit_events SET action = 'tampered.for.test' WHERE seq = ?",
            target,
          );
        },
      );
      const broken = await step("dopbase --json audit verify", async () =>
        app.cli(["--json", "audit", "verify"]).fails(2),
      );
      await step(`It exits 2 and names sequence ${target}`, async () => {
        const report = JSON.parse(broken.stdout);
        expect(report.ok).toBe(false);
        expect(report.broken.seq).toBe(target);
        expect(report.broken.reason).toContain("hash");
        expect(report.records).toBe(target - 1);
      });
      const human = await step("dopbase audit verify", async () =>
        app.cli(["audit", "verify"]).fails(2),
      );
      await step(`It reads Chain: BROKEN at sequence ${target}`, async () => {
        expect(human.stdout).toMatch(
          new RegExp(`Chain:\\s+BROKEN at sequence ${target} `),
        );
      });
    } finally {
      await sql(
        app.dataDir,
        "UPDATE audit_events SET action = ? WHERE seq = ?",
        row!.action,
        target,
      );
      if (trigger) await sql(app.dataDir, trigger.sql);
    }
    await step("With the row put back, the chain is intact again", async () => {
      const report = await app.cli(["--json", "audit", "verify"]).json();
      expect(report.ok).toBe(true);
    });
  },
);

test(
  "--actor narrows audit list and export to one person",
  {
    tag: "@audit",
    annotation: about(
      "`audit list --actor` and `audit export --actor` take an email or an actor ID and return only that person's events; an actor with no events gets an empty page.",
    ),
  },
  async () => {
    const member = await app.make.user({ role: "Member" });
    const env = await app.make.environment();
    await grant(app, member, "write", { project: env.projectName });
    await app
      .cli(["secret", "set", env.ref, "MEMBER_KEY", "--stdin"], {
        as: member,
        stdin: app.value(),
        record: false,
      })
      .ok();
    await app
      .cli(["secret", "set", env.ref, "ROOT_KEY", "--stdin"], {
        stdin: app.value(),
        record: false,
      })
      .ok();

    const byEmail = await step(
      `dopbase --json audit list --actor ${member.email}`,
      async () =>
        app.cli(["--json", "audit", "list", "--actor", member.email]).json(),
    );
    await step("Every event is the member's", async () => {
      expect(byEmail.items.length).toBeGreaterThan(0);
      for (const event of byEmail.items) expect(event.actorId).toBe(member.id);
      expect(byEmail.items.map((e: any) => e.action)).toContain(
        "secret.created",
      );
    });
    const byId = await step(
      `dopbase --json audit list --actor ${member.id}`,
      async () =>
        app.cli(["--json", "audit", "list", "--actor", member.id]).json(),
    );
    await step("The actor ID gives the same events", async () => {
      expect(byId.items.map((e: any) => e.seq)).toEqual(
        byEmail.items.map((e: any) => e.seq),
      );
    });

    const exported = await step(
      `dopbase audit export --actor ${ROOT_EMAIL} --environment ${env.ref}`,
      async () =>
        app
          .cli([
            "audit",
            "export",
            "--actor",
            ROOT_EMAIL,
            "--environment",
            env.ref,
          ])
          .stdout(),
    );
    await step("The export holds root's events, not the member's", async () => {
      const events = exported.split("\n").map((line) => JSON.parse(line));
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.actorId).not.toBe(member.id);
        expect(event.actorLabel).toBe(ROOT_EMAIL);
        expect(event.environmentId).toBe(env.id);
      }
    });

    const nobody = await step(
      "dopbase --json audit list --actor nobody@dopbase.com",
      async () =>
        app
          .cli(["--json", "audit", "list", "--actor", "nobody@dopbase.com"])
          .json(),
    );
    await step("An actor with no events gets an empty page", async () => {
      expect(nobody.items).toEqual([]);
    });
  },
);
