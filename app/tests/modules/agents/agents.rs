use super::audit_scope::with_role;
use super::grants_access::{As, Person, grant, instance, person, send};
use super::*;

/// Creates an AI agent as `by` and returns its id.
pub(crate) async fn agent(
  router: &Router,
  by: &Person,
  name: &str,
) -> String {
  let (status, body) = send(
    router,
    "POST",
    "/api/v1/agents",
    by.browser(),
    Some(json!({"name":name})),
  )
  .await;
  assert_eq!(status, 201, "{body}");
  assert_eq!(body["data"]["ownerId"], by.id);
  assert!(
    body["data"]["id"].as_str().unwrap().starts_with("agt_"),
    "{body}"
  );
  body["data"]["id"].as_str().unwrap().to_owned()
}

/// The people (by email) and then the AI agents (by name) `who` may list.
async fn listed(
  router: &Router,
  who: &Person,
) -> Vec<String> {
  let mut seen = Vec::new();
  for (path, field) in [("/api/v1/users", "email"), ("/api/v1/agents", "name")] {
    let (status, body) = send(router, "GET", path, who.browser(), None).await;
    assert_eq!(status, 200, "{path}: {body}");
    seen.extend(
      body["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|account| account[field].as_str().unwrap().to_owned()),
    );
  }
  seen
}

async fn custom_role(
  router: &Router,
  root: &Person,
  name: &str,
  capabilities: &[&str],
) -> String {
  custom_role_at(router, root, name, capabilities, "write").await
}

async fn custom_role_at(
  router: &Router,
  root: &Person,
  name: &str,
  capabilities: &[&str],
  max_level: &str,
) -> String {
  let (status, body) = send(
    router,
    "POST",
    "/api/v1/roles",
    root.browser(),
    Some(json!({"name":name,"capabilities":capabilities,"maxLevel":max_level})),
  )
  .await;
  assert_eq!(status, 201, "{body}");
  body["data"]["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn a_member_gives_their_own_agent_no_more_than_they_reach() {
  let (_dir, state, router) = test_app().await;
  let (root, env) = instance(&state, &router).await;
  // Three projects: payments and search from the instance, and billing.
  let (status, body) = send(
    &router,
    "POST",
    "/api/v1/projects",
    root.cli(),
    Some(json!({"name":"billing"})),
  )
  .await;
  assert_eq!(status, 201, "{body}");
  let maya = person(&router, &root, "maya@dopbase.com", "member").await;
  grant(
    &router,
    &root,
    ("user", &maya.id),
    ("project", Some("payments")),
    "write",
  )
  .await;

  // Maya creates an agent and owns it; it is the only account she sees.
  let bot = agent(&router, &maya, "ci-bot").await;
  assert_eq!(listed(&router, &maya).await, ["ci-bot"]);
  let (_, user) = send(
    &router,
    "GET",
    &format!("/api/v1/agents/{bot}"),
    maya.browser(),
    None,
  )
  .await;
  assert_eq!(user["data"]["ownerEmail"], "maya@dopbase.com");

  // On payments she gives it Names only, Read or Write, never more than
  // her own Write.
  for level in ["metadata", "read", "write"] {
    let (status, body) = grant(
      &router,
      &maya,
      ("agent", &bot),
      ("project", Some("payments")),
      level,
    )
    .await;
    assert_eq!(status, 200, "{level}: {body}");
  }
  for level in ["manage", "project_manager"] {
    let (status, body) = grant(
      &router,
      &maya,
      ("agent", &bot),
      ("project", Some("payments")),
      level,
    )
    .await;
    assert_eq!(status, 403, "{level}: {body}");
  }
  // The other two projects don't exist for her.
  for project in ["search", "billing"] {
    let (status, body) = grant(
      &router,
      &maya,
      ("agent", &bot),
      ("project", Some(project)),
      "read",
    )
    .await;
    assert_eq!(status, 404, "{project}: {body}");
  }
  // Nor does all projects.
  let (status, _) = grant(&router, &maya, ("agent", &bot), ("all", None), "read").await;
  assert_eq!(status, 403);

  // Once prod is protected her project Write stops there, so she can't
  // give it to the agent either; dev still works.
  let prod = &env["payments/prod"];
  let (status, body) = send(
    &router,
    "PATCH",
    &format!("/api/v1/environments/{prod}"),
    root.cli(),
    Some(json!({"protected":true})),
  )
  .await;
  assert_eq!(status, 200, "{body}");
  let (status, _) = grant(
    &router,
    &maya,
    ("agent", &bot),
    ("environment", Some(prod)),
    "read",
  )
  .await;
  assert_eq!(status, 404);
  let (status, body) = grant(
    &router,
    &maya,
    ("agent", &bot),
    ("environment", Some(&env["payments/dev"])),
    "read",
  )
  .await;
  assert_eq!(status, 200, "{body}");

  // She reads the agent's access, gives it a token, and the token reaches
  // payments only.
  let (status, access) = send(
    &router,
    "GET",
    &format!("/api/v1/agents/{bot}/access"),
    maya.browser(),
    None,
  )
  .await;
  assert_eq!(status, 200, "{access}");
  assert_eq!(access["data"]["grants"].as_array().unwrap().len(), 2);
  // Maya backs both grants in full, so neither carries an owner level.
  assert_eq!(access["data"]["ownerEmail"], "maya@dopbase.com");
  for grant in access["data"]["grants"].as_array().unwrap() {
    assert!(grant.get("ownerLevel").is_none(), "{grant}");
  }
  let (status, body) = send(
    &router,
    "POST",
    &format!("/api/v1/agents/{bot}/tokens"),
    maya.browser(),
    Some(json!({"name":"ci","level":"read"})),
  )
  .await;
  assert_eq!(status, 201, "{body}");
  let token = body["data"]["plaintextToken"].as_str().unwrap().to_owned();
  let token_id = body["data"]["token"]["id"].as_str().unwrap().to_owned();
  let runtime = |id: &str| format!("/api/v1/environments/{id}/secrets/runtime");
  let (status, _) = send(
    &router,
    "GET",
    &runtime(&env["payments/dev"]),
    As::Token(&token),
    None,
  )
  .await;
  assert_eq!(status, 200);
  let (status, _) = send(
    &router,
    "GET",
    &runtime(&env["search/dev"]),
    As::Token(&token),
    None,
  )
  .await;
  assert_eq!(status, 404);

  // Cutting Maya to Names only cuts the agent too, though its grant says
  // Write.
  grant(
    &router,
    &root,
    ("user", &maya.id),
    ("project", Some("payments")),
    "metadata",
  )
  .await;
  let (status, _) = send(
    &router,
    "GET",
    &runtime(&env["payments/dev"]),
    As::Token(&token),
    None,
  )
  .await;
  assert_eq!(status, 403);
  // The access report says so: each grant shows the owner's lower level.
  let (status, capped) = send(
    &router,
    "GET",
    &format!("/api/v1/agents/{bot}/access"),
    maya.browser(),
    None,
  )
  .await;
  assert_eq!(status, 200, "{capped}");
  for grant in capped["data"]["grants"].as_array().unwrap() {
    assert_eq!(grant["ownerLevel"], "metadata", "{grant}");
  }

  // She renames, disables and enables it, revokes its token and takes its
  // access away, but can't hand it to someone else.
  let item = format!("/api/v1/agents/{bot}");
  let (status, body) = send(
    &router,
    "PATCH",
    &item,
    maya.browser(),
    Some(json!({"name":"deploy-bot"})),
  )
  .await;
  assert_eq!(status, 200, "{body}");
  for action in ["disable", "enable"] {
    let (status, body) = send(
      &router,
      "POST",
      &format!("{item}/{action}"),
      maya.browser(),
      None,
    )
    .await;
    assert_eq!(status, 200, "{action}: {body}");
  }
  let (status, body) = send(
    &router,
    "POST",
    &format!("{item}/tokens/{token_id}/revoke"),
    maya.browser(),
    None,
  )
  .await;
  assert_eq!(status, 200, "{body}");
  let other = person(&router, &root, "other@dopbase.com", "member").await;
  let (status, body) = send(
    &router,
    "PATCH",
    &item,
    maya.browser(),
    Some(json!({"ownerId":other.id})),
  )
  .await;
  assert_eq!(status, 403, "{body}");
  let grant_id = access["data"]["grants"][0]["id"].as_str().unwrap();
  let (status, body) = send(
    &router,
    "DELETE",
    &format!("/api/v1/grants/{grant_id}"),
    maya.browser(),
    None,
  )
  .await;
  assert_eq!(status, 200, "{body}");

  // Every grant she gave is in the audit log under her.
  let given: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM audit_events WHERE action = 'grant.set' AND actor_id = ?",
  )
  .bind(&maya.id)
  .fetch_one(state.db.pool())
  .await
  .unwrap();
  assert_eq!(given, 4);

  let (status, _) = send(&router, "DELETE", &item, maya.browser(), None).await;
  assert_eq!(status, 200);
  state.db.close().await;
}

#[tokio::test]
async fn an_owner_reaches_only_their_own_agents_and_never_people() {
  let (_dir, state, router) = test_app().await;
  let (root, _) = instance(&state, &router).await;
  let maya = person(&router, &root, "maya@dopbase.com", "member").await;
  grant(
    &router,
    &root,
    ("user", &maya.id),
    ("project", Some("payments")),
    "write",
  )
  .await;
  let sam = person(&router, &root, "sam@dopbase.com", "admin").await;
  let theirs = agent(&router, &sam, "sam-bot").await;
  let item = format!("/api/v1/agents/{theirs}");

  // Someone else's agent, and every person, doesn't exist for her.
  for path in [
    format!("/api/v1/agents/{theirs}"),
    format!("/api/v1/users/{}", sam.id),
  ] {
    let (status, _) = send(&router, "GET", &path, maya.browser(), None).await;
    assert_eq!(status, 404, "{path}");
  }
  // She can't change it, read or make its tokens, or give it access, even
  // on payments where she has Write: only a project manager grants to
  // agents she doesn't own.
  for (method, path, body) in [
    ("PATCH", item.clone(), Some(json!({"name":"mine-now"}))),
    ("POST", format!("{item}/disable"), None),
    ("DELETE", item.clone(), None),
    ("GET", format!("{item}/tokens"), None),
    (
      "POST",
      format!("{item}/tokens"),
      Some(json!({"name":"x","level":"read"})),
    ),
    ("GET", format!("{item}/access"), None),
  ] {
    let (status, response) = send(&router, method, &path, maya.browser(), body).await;
    assert_eq!(status, 403, "{method} {path}: {response}");
  }
  let (status, _) = grant(
    &router,
    &maya,
    ("agent", &theirs),
    ("project", Some("payments")),
    "read",
  )
  .await;
  assert_eq!(status, 403);
  // Nor does agents.view add people.
  let (status, body) = send(
    &router,
    "POST",
    "/api/v1/users",
    maya.browser(),
    Some(json!({"email":"new@dopbase.com","password":"correct-horse-123","role":"member"})),
  )
  .await;
  assert_eq!(status, 403, "{body}");
  // And a CLI session can't create agents.
  let (status, _) = send(
    &router,
    "POST",
    "/api/v1/agents",
    maya.cli(),
    Some(json!({"name":"cli-bot"})),
  )
  .await;
  assert_eq!(status, 403);
  state.db.close().await;
}

#[tokio::test]
async fn seeing_every_agent_and_managing_them_are_separate_capabilities() {
  let (_dir, state, router) = test_app().await;
  let (root, _) = instance(&state, &router).await;
  let maya = person(&router, &root, "maya@dopbase.com", "member").await;
  let bot = agent(&router, &maya, "maya-bot").await;
  let item = format!("/api/v1/agents/{bot}");

  // agents.view_all sees every agent and its owner, but no people, and
  // changes nothing.
  let lead_role = custom_role(
    &router,
    &root,
    "Agent lead",
    &["tokens.personal", "agents.view", "agents.view_all"],
  )
  .await;
  let lead = with_role(&router, &root, "lead@dopbase.com", &lead_role).await;
  assert_eq!(listed(&router, &lead).await, ["maya-bot"]);
  let (_, user) = send(&router, "GET", &item, lead.browser(), None).await;
  assert_eq!(user["data"]["ownerEmail"], "maya@dopbase.com");
  for path in [format!("{item}/access"), format!("{item}/tokens")] {
    let (status, body) = send(&router, "GET", &path, lead.browser(), None).await;
    assert_eq!(status, 200, "{path}: {body}");
  }
  for (method, path, body) in [
    ("PATCH", item.clone(), Some(json!({"name":"lead-bot"}))),
    ("POST", format!("{item}/disable"), None),
    (
      "POST",
      format!("{item}/tokens"),
      Some(json!({"name":"x","level":"read"})),
    ),
    ("DELETE", item.clone(), None),
  ] {
    let (status, response) = send(&router, method, &path, lead.browser(), body).await;
    assert_eq!(status, 403, "{method} {path}: {response}");
  }

  // users.view and users.manage no longer reach agents.
  let people_role = custom_role(
    &router,
    &root,
    "People admin",
    &["users.view", "users.manage"],
  )
  .await;
  // The upgrade gives custom roles agent capabilities; a role made now
  // has only what it is given.
  let people = with_role(&router, &root, "people@dopbase.com", &people_role).await;
  assert!(
    !listed(&router, &people)
      .await
      .contains(&"maya-bot".to_owned())
  );
  let (status, _) = send(&router, "GET", &item, people.browser(), None).await;
  assert_eq!(status, 404);
  let (status, body) = send(
    &router,
    "PATCH",
    &item,
    people.browser(),
    Some(json!({"name":"people-bot"})),
  )
  .await;
  assert_eq!(status, 403, "{body}");
  let (status, body) = send(
    &router,
    "POST",
    "/api/v1/agents",
    people.browser(),
    Some(json!({"name":"people-bot"})),
  )
  .await;
  assert_eq!(status, 403, "{body}");

  // agents.manage changes and transfers anyone's agent. The new owner must
  // hold agents.view: the lead does, an auditor doesn't.
  let sam = person(&router, &root, "sam@dopbase.com", "admin").await;
  let (status, body) = send(
    &router,
    "PATCH",
    &item,
    sam.browser(),
    Some(json!({"name":"renamed-bot"})),
  )
  .await;
  assert_eq!(status, 200, "{body}");
  let auditor = with_role(&router, &root, "auditor@dopbase.com", "rol_auditor").await;
  let (status, body) = send(
    &router,
    "PATCH",
    &item,
    sam.browser(),
    Some(json!({"ownerId":auditor.id})),
  )
  .await;
  assert_eq!(status, 400, "{body}");
  assert!(body["error"]["OWNER_INVALID"].is_string());
  let (status, body) = send(
    &router,
    "PATCH",
    &item,
    sam.browser(),
    Some(json!({"ownerId":lead.id})),
  )
  .await;
  assert_eq!(status, 200, "{body}");
  assert_eq!(body["data"]["ownerEmail"], "lead@dopbase.com");
  // It is the lead's now, so Maya no longer sees it.
  assert!(listed(&router, &maya).await.is_empty());
  let (status, body) = send(
    &router,
    "POST",
    &format!("{item}/tokens"),
    sam.browser(),
    Some(json!({"name":"ops","level":"read"})),
  )
  .await;
  assert_eq!(status, 201, "{body}");
  state.db.close().await;
}

#[tokio::test]
async fn built_in_roles_hold_the_agent_capabilities_they_should() {
  let (_dir, state, router) = test_app().await;
  let (root, _) = instance(&state, &router).await;
  for (role, expected) in [
    (
      "rol_admin",
      ["agents.manage", "agents.view", "agents.view_all"].as_slice(),
    ),
    ("rol_member", &["agents.view"]),
    ("rol_auditor", &["agents.view_all"]),
  ] {
    let who = with_role(&router, &root, &format!("{role}@dopbase.com"), role).await;
    let (status, session) = send(&router, "GET", "/api/v1/auth/session", who.browser(), None).await;
    assert_eq!(status, 200, "{session}");
    let mut held: Vec<String> = session["data"]["capabilities"]
      .as_array()
      .unwrap()
      .iter()
      .filter_map(|capability| capability.as_str())
      .filter(|capability| capability.starts_with("agents."))
      .map(str::to_owned)
      .collect();
    held.sort();
    assert_eq!(held, expected, "{role}");
  }
  state.db.close().await;
}

#[tokio::test]
async fn only_agents_manage_gives_someone_elses_agent_access() {
  let (_dir, state, router) = test_app().await;
  let (root, _) = instance(&state, &router).await;
  let maya = person(&router, &root, "maya@dopbase.com", "member").await;
  let bot = agent(&router, &maya, "maya-bot").await;

  // Both manage payments; one holds users.*, the other agents.manage.
  let people_role = custom_role_at(
    &router,
    &root,
    "People admin",
    &["users.view", "users.manage"],
    "project_manager",
  )
  .await;
  let lead_role = custom_role_at(
    &router,
    &root,
    "Agent lead",
    &["tokens.personal", "agents.view_all", "agents.manage"],
    "project_manager",
  )
  .await;
  let people = with_role(&router, &root, "people@dopbase.com", &people_role).await;
  let lead = with_role(&router, &root, "lead@dopbase.com", &lead_role).await;
  for who in [&people, &lead] {
    let (status, body) = grant(
      &router,
      &root,
      ("user", &who.id),
      ("project", Some("payments")),
      "project_manager",
    )
    .await;
    assert_eq!(status, 200, "{body}");
  }

  // users.view doesn't reach the agent; agents.manage does.
  let (status, body) = grant(
    &router,
    &people,
    ("agent", &bot),
    ("project", Some("payments")),
    "read",
  )
  .await;
  assert_eq!(status, 422, "{body}");
  assert!(
    body["error"]["GRANT_PRINCIPAL_INVALID"].is_string(),
    "{body}"
  );
  let (status, body) = grant(
    &router,
    &lead,
    ("agent", &bot),
    ("project", Some("payments")),
    "read",
  )
  .await;
  assert_eq!(status, 200, "{body}");
  // agents.manage doesn't reach people, and the people admin still does.
  let (status, body) = grant(
    &router,
    &lead,
    ("user", &maya.id),
    ("project", Some("payments")),
    "read",
  )
  .await;
  assert_eq!(status, 422, "{body}");
  assert!(
    body["error"]["GRANT_PRINCIPAL_INVALID"].is_string(),
    "{body}"
  );
  let (status, body) = grant(
    &router,
    &people,
    ("user", &maya.id),
    ("project", Some("payments")),
    "read",
  )
  .await;
  assert_eq!(status, 200, "{body}");
  state.db.close().await;
}

#[tokio::test]
async fn agents_manage_hands_agents_over_but_creates_none() {
  let (_dir, state, router) = test_app().await;
  let (root, _) = instance(&state, &router).await;
  let maya = person(&router, &root, "maya@dopbase.com", "member").await;
  let other = person(&router, &root, "other@dopbase.com", "member").await;
  with_role(&router, &root, "auditor@dopbase.com", "rol_auditor").await;
  let bot = agent(&router, &maya, "maya-bot").await;
  let lead_role = custom_role(
    &router,
    &root,
    "Agent lead",
    &["tokens.personal", "agents.view_all", "agents.manage"],
  )
  .await;
  let lead = with_role(&router, &root, "lead@dopbase.com", &lead_role).await;

  // Whoever creates an agent owns it, and owning one takes agents.view.
  let (status, body) = send(
    &router,
    "POST",
    "/api/v1/agents",
    lead.browser(),
    Some(json!({"name":"lead-bot"})),
  )
  .await;
  assert_eq!(status, 403, "{body}");
  // Naming another owner on create is refused out loud, not dropped, and
  // nothing is created.
  let (status, body) = send(
    &router,
    "POST",
    "/api/v1/agents",
    maya.browser(),
    Some(json!({"name":"gift-bot","ownerId":other.id})),
  )
  .await;
  assert_eq!(status, 400, "{body}");
  assert!(body["error"]["OWNER_NOT_SETTABLE"].is_string(), "{body}");
  assert!(
    !listed(&router, &root)
      .await
      .contains(&"gift-bot".to_owned())
  );

  // The lead sees the people who could own an agent, so the console can
  // offer them, but not the ones who couldn't.
  let seen = listed(&router, &lead).await;
  for email in ["maya@dopbase.com", "other@dopbase.com", "maya-bot"] {
    assert!(seen.contains(&email.to_owned()), "{email}: {seen:?}");
  }
  assert!(
    !seen.contains(&"auditor@dopbase.com".to_owned()),
    "{seen:?}"
  );
  // Maya gave her agent a token before it changes hands.
  let (status, body) = send(
    &router,
    "POST",
    &format!("/api/v1/agents/{bot}/tokens"),
    maya.browser(),
    Some(json!({"name":"ci","level":"read"})),
  )
  .await;
  assert_eq!(status, 201, "{body}");
  let token = body["data"]["plaintextToken"].as_str().unwrap().to_owned();
  let me = "/api/v1/users/me/access";
  // Naming the same owner again hands nothing over, so the token lives.
  let (status, body) = send(
    &router,
    "PATCH",
    &format!("/api/v1/agents/{bot}"),
    lead.browser(),
    Some(json!({"ownerId":maya.id})),
  )
  .await;
  assert_eq!(status, 200, "{body}");
  let (status, _) = send(&router, "GET", me, As::Token(&token), None).await;
  assert_eq!(status, 200);

  let (status, body) = send(
    &router,
    "PATCH",
    &format!("/api/v1/agents/{bot}"),
    lead.browser(),
    Some(json!({"ownerId":other.id})),
  )
  .await;
  assert_eq!(status, 200, "{body}");
  assert_eq!(body["data"]["ownerEmail"], "other@dopbase.com");
  // A new owner starts with no tokens, so Maya's copy stops working.
  let (status, _) = send(&router, "GET", me, As::Token(&token), None).await;
  assert_eq!(status, 401);
  let (status, body) = send(
    &router,
    "GET",
    &format!("/api/v1/agents/{bot}/tokens"),
    other.browser(),
    None,
  )
  .await;
  assert_eq!(status, 200, "{body}");
  assert!(body["data"][0]["revokedAt"].is_string(), "{body}");
  let revoked: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM audit_events WHERE action = 'personal_token.revoked' AND actor_id = ? AND metadata LIKE '%owner_changed%'",
  )
  .bind(&lead.id)
  .fetch_one(state.db.pool())
  .await
  .unwrap();
  assert_eq!(revoked, 1);
  state.db.close().await;
}

#[tokio::test]
async fn an_owner_doesnt_undo_a_disable_by_agents_manage() {
  let (_dir, state, router) = test_app().await;
  let (root, _) = instance(&state, &router).await;
  let maya = person(&router, &root, "maya@dopbase.com", "member").await;
  let sam = person(&router, &root, "sam@dopbase.com", "admin").await;
  let bot = agent(&router, &maya, "maya-bot").await;
  let item = format!("/api/v1/agents/{bot}");
  // Sam turns it off, and it stays off until agents.manage turns it on.
  // Her own disable she undoes herself.
  for (who, action, expected) in [
    (&sam, "disable", 200),
    (&maya, "enable", 403),
    (&sam, "enable", 200),
    (&maya, "disable", 200),
    (&maya, "enable", 200),
  ] {
    let (status, body) = send(
      &router,
      "POST",
      &format!("{item}/{action}"),
      who.browser(),
      None,
    )
    .await;
    assert_eq!(status, expected, "{action}: {body}");
  }
  state.db.close().await;
}

#[tokio::test]
async fn an_agent_owner_cant_probe_other_accounts() {
  let (_dir, state, router) = test_app().await;
  let (root, _) = instance(&state, &router).await;
  let maya = person(&router, &root, "maya@dopbase.com", "member").await;
  let sam = person(&router, &root, "sam@dopbase.com", "admin").await;
  agent(&router, &maya, "maya-bot").await;

  // Root, a person and a missing id answer alike, whatever she asks and
  // whichever endpoint she asks it on.
  for item in [root.id.as_str(), sam.id.as_str(), "usr_missing"]
    .into_iter()
    .flat_map(|id| {
      [
        format!("/api/v1/users/{id}"),
        format!("/api/v1/agents/{id}"),
      ]
    })
  {
    let rename = if item.starts_with("/api/v1/agents") {
      json!({"name":"x-bot"})
    } else {
      json!({"email":"x@dopbase.com"})
    };
    for (method, path, body) in [
      ("PATCH", item.clone(), Some(rename)),
      ("POST", format!("{item}/disable"), None),
      ("POST", format!("{item}/enable"), None),
      ("DELETE", item.clone(), None),
    ] {
      let (status, response) = send(&router, method, &path, maya.browser(), body).await;
      assert_eq!(status, 403, "{method} {path}: {response}");
      assert!(
        response["error"]["AUTHORIZATION_DENIED"].is_string(),
        "{method} {path}: {response}"
      );
    }
  }

  // Access and tokens answer an id of the other kind as they answer a
  // missing one, so they don't tell her which ids are AI agents either.
  let roots_bot = agent(&router, &root, "root-bot").await;
  for (other_kind, missing) in [
    (
      format!("/api/v1/users/{roots_bot}"),
      "/api/v1/users/usr_missing",
    ),
    (
      format!("/api/v1/agents/{}", sam.id),
      "/api/v1/agents/agt_missing",
    ),
  ] {
    for tail in ["access", "tokens"] {
      let path = format!("{other_kind}/{tail}");
      let (status, response) = send(&router, "GET", &path, maya.browser(), None).await;
      let (missing_status, missing_response) = send(
        &router,
        "GET",
        &format!("{missing}/{tail}"),
        maya.browser(),
        None,
      )
      .await;
      assert_eq!(status, missing_status, "{path}: {response}");
      assert_eq!(response["error"], missing_response["error"], "{path}");
    }
  }
  state.db.close().await;
}

#[tokio::test]
async fn an_agent_id_that_doesnt_exist_is_missing_to_whoever_manages_agents() {
  let (_dir, state, router) = test_app().await;
  let (root, _) = instance(&state, &router).await;
  let maya = person(&router, &root, "maya@dopbase.com", "member").await;
  let bot = agent(&router, &maya, "maya-bot").await;

  // Someone who sees and manages every agent, but no people, hears that a
  // mistyped agent id doesn't exist, on every agent endpoint.
  let lead_role = custom_role(
    &router,
    &root,
    "Agent admin",
    &["agents.view", "agents.view_all", "agents.manage"],
  )
  .await;
  let lead = with_role(&router, &root, "lead@dopbase.com", &lead_role).await;
  for (method, path, body) in [
    ("GET", "/api/v1/agents/agt_typo", None),
    ("GET", "/api/v1/agents/agt_typo/access", None),
    ("GET", "/api/v1/agents/agt_typo/tokens", None),
    (
      "POST",
      "/api/v1/agents/agt_typo/tokens",
      Some(json!({"name":"x","level":"read"})),
    ),
    ("POST", "/api/v1/agents/agt_typo/tokens/pat_x/revoke", None),
  ] {
    let (status, response) = send(&router, method, path, lead.browser(), body).await;
    assert_eq!(status, 404, "{method} {path}: {response}");
    assert!(
      response["error"]["AGENT_NOT_FOUND"].is_string(),
      "{method} {path}: {response}"
    );
  }

  // Someone who sees only people gets the same answer for an agent that
  // exists as for one that doesn't, so agent ids can't be probed.
  let people_role = custom_role(&router, &root, "People viewer", &["users.view"]).await;
  let viewer = with_role(&router, &root, "viewer@dopbase.com", &people_role).await;
  for tail in ["access", "tokens"] {
    let real = format!("/api/v1/agents/{bot}/{tail}");
    let missing = format!("/api/v1/agents/agt_missing/{tail}");
    let (status, response) = send(&router, "GET", &real, viewer.browser(), None).await;
    let (missing_status, missing_response) =
      send(&router, "GET", &missing, viewer.browser(), None).await;
    assert_eq!(status, missing_status, "{real}: {response}");
    assert_eq!(response["error"], missing_response["error"], "{real}");
  }
  state.db.close().await;
}

#[tokio::test]
async fn people_and_agents_stay_on_their_own_endpoints() {
  let (_dir, state, router) = test_app().await;
  let (root, _) = instance(&state, &router).await;
  let maya = person(&router, &root, "maya@dopbase.com", "member").await;
  let bot = agent(&router, &maya, "maya-bot").await;

  // Each list holds one kind only, even for root who sees everyone.
  let (_, people) = send(&router, "GET", "/api/v1/users", root.browser(), None).await;
  let people: Vec<&str> = people["data"]
    .as_array()
    .unwrap()
    .iter()
    .map(|user| user["id"].as_str().unwrap())
    .collect();
  assert!(people.contains(&maya.id.as_str()), "{people:?}");
  assert!(!people.contains(&bot.as_str()), "{people:?}");
  let (_, agents) = send(&router, "GET", "/api/v1/agents", root.browser(), None).await;
  let agents: Vec<&str> = agents["data"]
    .as_array()
    .unwrap()
    .iter()
    .map(|agent| agent["id"].as_str().unwrap())
    .collect();
  assert_eq!(agents, [bot.as_str()]);

  // An agent's id on a people endpoint, or a person's on an agent
  // endpoint, is not found, even for root.
  for (path, code) in [
    (format!("/api/v1/users/{bot}"), "USER_NOT_FOUND"),
    (format!("/api/v1/users/{bot}/access"), "USER_NOT_FOUND"),
    (format!("/api/v1/users/{bot}/tokens"), "USER_NOT_FOUND"),
    (format!("/api/v1/agents/{}", maya.id), "AGENT_NOT_FOUND"),
    (
      format!("/api/v1/agents/{}/access", maya.id),
      "AGENT_NOT_FOUND",
    ),
    (
      format!("/api/v1/agents/{}/tokens", maya.id),
      "AGENT_NOT_FOUND",
    ),
  ] {
    let (status, body) = send(&router, "GET", &path, root.browser(), None).await;
    assert_eq!(status, 404, "{path}: {body}");
    assert!(body["error"][code].is_string(), "{path}: {body}");
  }
  let (status, body) = send(
    &router,
    "POST",
    &format!("/api/v1/users/{bot}/disable"),
    root.browser(),
    None,
  )
  .await;
  assert_eq!(status, 404, "{body}");

  // `me` on the agent endpoints is never a person, so a person can't read
  // or make their own tokens there.
  for (method, path, request) in [
    ("GET", "/api/v1/agents/me/access", None),
    ("GET", "/api/v1/agents/me/tokens", None),
    (
      "POST",
      "/api/v1/agents/me/tokens",
      Some(json!({"name":"through-agents"})),
    ),
  ] {
    let (status, body) = send(&router, method, path, root.browser(), request).await;
    assert_eq!(status, 404, "{method} {path}: {body}");
    assert!(
      body["error"]["AGENT_NOT_FOUND"].is_string(),
      "{method} {path}: {body}"
    );
  }

  // People are added at /users and AI agents at /agents, never the other
  // way round.
  let (status, body) = send(
    &router,
    "POST",
    "/api/v1/users",
    root.browser(),
    Some(json!({"email":"build-bot","role":"ai_agent"})),
  )
  .await;
  assert_eq!(status, 400, "{body}");
  assert!(body["error"]["ROLE_INVALID"].is_string(), "{body}");
  let (status, body) = send(
    &router,
    "POST",
    "/api/v1/agents",
    root.browser(),
    Some(json!({"name":"build-bot","roleId":"rol_member"})),
  )
  .await;
  assert_eq!(status, 400, "{body}");
  assert!(body["error"]["ROLE_INVALID"].is_string(), "{body}");
  // A person has no owner, so ownerId is refused as it is on a change.
  let (status, body) = send(
    &router,
    "POST",
    "/api/v1/users",
    root.browser(),
    Some(json!({"email":"sam@dopbase.com","password":"correct-horse-battery","role":"member","ownerId":maya.id})),
  )
  .await;
  assert_eq!(status, 400, "{body}");
  assert!(body["error"]["OWNER_INVALID"].is_string(), "{body}");

  // A grant names the kind it gives access to, and it has to be right.
  for (principal, id) in [("user", bot.as_str()), ("agent", maya.id.as_str())] {
    let (status, body) = grant(
      &router,
      &root,
      (principal, id),
      ("project", Some("payments")),
      "read",
    )
    .await;
    assert_eq!(status, 422, "{principal}: {body}");
    assert!(
      body["error"]["GRANT_PRINCIPAL_INVALID"].is_string(),
      "{body}"
    );
  }
  let (status, body) = grant(
    &router,
    &root,
    ("agent", &bot),
    ("project", Some("payments")),
    "read",
  )
  .await;
  assert_eq!(status, 200, "{body}");
  assert_eq!(body["data"]["principalType"], "agent");
  assert_eq!(body["data"]["principalLabel"], "maya-bot");

  // Two agents can't share a name, whatever the case.
  let (status, body) = send(
    &router,
    "POST",
    "/api/v1/agents",
    maya.browser(),
    Some(json!({"name":"Maya-Bot"})),
  )
  .await;
  assert_eq!(status, 409, "{body}");
  assert!(body["error"]["AGENT_NAME_TAKEN"].is_string(), "{body}");
  state.db.close().await;
}
