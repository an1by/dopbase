import { grant } from "../harness/helpers.ts";
import { about, expect, step, test, useServer } from "../harness/index.ts";
import { ALL_FEATURES, expectError, expectOk, QUIET } from "./support.ts";

const app = useServer({ env: ALL_FEATURES });

test(
  "group create, read, rename and delete",
  {
    tag: "@access",
    annotation: about(
      "Root creates a group, finds it in the list and by id, renames it and changes its description, and deletes it; duplicates are 409 and unknown ids 404.",
    ),
  },
  async () => {
    const name = app.uniq("Platform");
    const group = await step(`POST /groups ${name}`, async () => {
      const created = expectOk(
        await app.api.post("/groups", { name, description: "Runs the infra." }),
        201,
      );
      expect(created.group).toMatchObject({
        name,
        description: "Runs the infra.",
        memberCount: 0,
      });
      expect(created.members).toEqual([]);
      return created.group;
    });
    await step("POST /groups with the same name is 409", async () => {
      expectError(
        await app.api.post("/groups", { name }),
        409,
        "GROUP_ALREADY_EXISTS",
      );
    });
    await step("POST /groups with an empty name is 422", async () => {
      expectError(
        await app.api.post("/groups", { name: "" }),
        422,
        "GROUP_NAME_INVALID",
      );
    });
    await step("GET /groups lists it", async () => {
      const list = expectOk(await app.api.get("/groups"));
      expect(list.map((g: { id: string }) => g.id)).toContain(group.id);
    });
    await step("GET /groups/{id}", async () => {
      expect(
        expectOk(await app.api.get(`/groups/${group.id}`)).group.name,
      ).toBe(name);
    });
    const renamed = `${name} core`;
    await step("PATCH /groups/{id} renames it", async () => {
      const updated = expectOk(
        await app.api.patch(`/groups/${group.id}`, {
          name: renamed,
          description: "Core infra.",
        }),
      );
      expect(updated.group).toMatchObject({
        name: renamed,
        description: "Core infra.",
      });
    });
    await step("DELETE /groups/{id}", async () => {
      expectOk(await app.api.delete(`/groups/${group.id}`));
    });
    await step("The deleted group is 404 everywhere", async () => {
      expectError(
        await app.api.get(`/groups/${group.id}`),
        404,
        "GROUP_NOT_FOUND",
      );
      expectError(
        await app.api.patch(`/groups/${group.id}`, { name: "x" }),
        404,
        "GROUP_NOT_FOUND",
      );
      expectError(
        await app.api.delete(`/groups/${group.id}`),
        404,
        "GROUP_NOT_FOUND",
      );
    });
    await step("Group routes without a session are 401", async () => {
      const anonymous = await app.anonymousApi();
      expectError(await anonymous.get("/groups"), 401);
      expectError(await anonymous.post("/groups", { name: "x" }), 401);
    });
    await step("A Member can't create groups (403)", async () => {
      const api = await app.apiAs(await app.make.user());
      expectError(
        await api.post("/groups", { name: app.uniq("mine") }),
        403,
        "AUTHORIZATION_DENIED",
      );
    });
  },
);

test(
  "add and remove group members",
  {
    tag: "@access",
    annotation: about(
      "PUT /groups/{id}/members/{userId} adds a person and DELETE removes them; the group and the person both show the membership while it lasts.",
    ),
  },
  async () => {
    const group = (
      await app.api.must("POST", "/groups", { name: app.uniq("Team") }, QUIET)
    ).group;
    const member = await app.make.user();
    await step("PUT /groups/{id}/members/{userId}", async () => {
      const result = expectOk(
        await app.api.put(`/groups/${group.id}/members/${member.id}`),
      );
      expect(result.members.map((m: { id: string }) => m.id)).toContain(
        member.id,
      );
    });
    await step(
      "The group counts one member, and the person lists the group",
      async () => {
        expect(
          expectOk(await app.api.get(`/groups/${group.id}`)).group.memberCount,
        ).toBe(1);
        const user = await app.api.must(
          "GET",
          `/users/${member.id}`,
          undefined,
          QUIET,
        );
        expect(user.groups.map((g: { id: string }) => g.id)).toContain(
          group.id,
        );
      },
    );
    await step("Adding an unknown person is 422", async () => {
      expectError(
        await app.api.put(`/groups/${group.id}/members/usr_unknown`),
        422,
        "GROUP_MEMBER_INVALID",
      );
    });
    await step("Adding to an unknown group is 404", async () => {
      expectError(
        await app.api.put(`/groups/grp_unknown/members/${member.id}`),
        404,
        "GROUP_NOT_FOUND",
      );
    });
    await step("DELETE /groups/{id}/members/{userId}", async () => {
      const result = expectOk(
        await app.api.delete(`/groups/${group.id}/members/${member.id}`),
      );
      expect(result.members).toEqual([]);
    });
    await step("Removing them again is 404", async () => {
      expectError(
        await app.api.delete(`/groups/${group.id}/members/${member.id}`),
        404,
        "GROUP_MEMBER_NOT_FOUND",
      );
    });
  },
);

test(
  "members get the group's grants and lose them on removal",
  {
    tag: "@access",
    annotation: about(
      "A group granted write on a project passes that write to its members; removing a member takes it away, and deleting the group takes it from everyone.",
    ),
  },
  async () => {
    const group = (
      await app.api.must(
        "POST",
        "/groups",
        { name: app.uniq("Writers") },
        QUIET,
      )
    ).group;
    const env = await app.make.environment();
    await app.make.secret(env, "API_KEY");
    await grant(app, { type: "group", id: group.id }, "write", {
      project: env.projectId,
    });
    const [ann, bob] = [await app.make.user(), await app.make.user()];
    const [annApi, bobApi] = [await app.apiAs(ann), await app.apiAs(bob)];
    const write = (api: typeof annApi) =>
      api.put(`/environments/${env.id}/secrets/API_KEY`, {
        value: app.value(),
      });
    await step(
      "Outside the group Ann can't see the environment (404)",
      async () => {
        expectError(await write(annApi), 404, "ENVIRONMENT_NOT_FOUND");
      },
    );
    await step("PUT /groups/{id}/members for Ann and Bob", async () => {
      expectOk(await app.api.put(`/groups/${group.id}/members/${ann.id}`));
      expectOk(await app.api.put(`/groups/${group.id}/members/${bob.id}`));
    });
    await step("Both write through the group grant", async () => {
      expectOk(await write(annApi));
      expectOk(await write(bobApi));
    });
    await step("GET /users/{id}/access shows the group", async () => {
      const access = await app.api.must(
        "GET",
        `/users/${ann.id}/access`,
        undefined,
        QUIET,
      );
      expect(access.groups.map((g: { id: string }) => g.id)).toContain(
        group.id,
      );
    });
    await step(
      "DELETE /groups/{id}/members/{Ann}: Ann loses access",
      async () => {
        expectOk(await app.api.delete(`/groups/${group.id}/members/${ann.id}`));
        expectError(await write(annApi), 404, "ENVIRONMENT_NOT_FOUND");
        expectOk(await write(bobApi));
      },
    );
    await step("DELETE /groups/{id}: Bob loses access too", async () => {
      expectOk(await app.api.delete(`/groups/${group.id}`));
      expectError(await write(bobApi), 404, "ENVIRONMENT_NOT_FOUND");
    });
  },
);
