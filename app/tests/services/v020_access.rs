//! Access resolution as one table: who (a person by role, an AI agent
//! through its owner, a personal token by scope and level, a runner) by
//! what (a plain environment, a protected one, one cut out with a `none`
//! grant) gives which level, through the module requests use, without the
//! router. Here to prove the 0.2.0 rewrite safe; drop it once end-to-end
//! tests cover the same ground.

use app::models::{AdminRole, AuthIdentity, SessionKind};
use app::services::{
  access::{Reach, Refusal},
  authx::{self, Level, Scope},
  db::{DbClient, MIGRATOR},
  features::Features,
};

async fn instance() -> DbClient {
  let db = DbClient::connect("sqlite::memory:").await.unwrap();
  MIGRATOR.run(db.pool()).await.unwrap();
  for statement in [
    "INSERT INTO accounts (id, kind, is_root, role_id, created_at, updated_at) VALUES ('usr_root', 'user', 1, NULL, 't', 't'), ('usr_member', 'user', 0, 'rol_member', 't', 't'), ('usr_lead', 'user', 0, 'rol_admin', 't', 't'), ('usr_auditor', 'user', 0, 'rol_auditor', 't', 't'), ('agt_bot', 'agent', 0, 'rol_ai_agent', 't', 't')",
    "INSERT INTO users (id, email) VALUES ('usr_root', 'root@dopbase.com'), ('usr_member', 'member@dopbase.com'), ('usr_lead', 'lead@dopbase.com'), ('usr_auditor', 'auditor@dopbase.com')",
    "INSERT INTO agents (id, name, owner_id) VALUES ('agt_bot', 'bot', 'usr_member')",
    "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj_pay', 'payments', 't', 't'), ('prj_web', 'web', 't', 't')",
    "INSERT INTO environments (id, project_id, name, protected, created_at, updated_at) VALUES ('env_dev', 'prj_pay', 'dev', 0, 't', 't'), ('env_prod', 'prj_pay', 'prod', 1, 't', 't'), ('env_cut', 'prj_pay', 'cut', 0, 't', 't'), ('env_web', 'prj_web', 'dev', 0, 't', 't')",
    // The member writes to payments, which stops at protected prod and at
    // the environment cut out with `none`.
    "INSERT INTO grants (id, account_id, scope, project_id, level, created_at, updated_at) VALUES ('g1', 'usr_member', 'project', 'prj_pay', 'write', 't', 't')",
    "INSERT INTO grants (id, account_id, scope, project_id, environment_id, level, created_at, updated_at) VALUES ('g2', 'usr_member', 'environment', 'prj_pay', 'env_cut', 'none', 't', 't')",
    // The lead manages payments as project manager, prod included.
    "INSERT INTO grants (id, account_id, scope, project_id, level, created_at, updated_at) VALUES ('g3', 'usr_lead', 'project', 'prj_pay', 'project_manager', 't', 't')",
    // The auditor is given write everywhere but its role stops at metadata.
    "INSERT INTO grants (id, account_id, scope, level, created_at, updated_at) VALUES ('g4', 'usr_auditor', 'all', 'write', 't', 't')",
    // The agent is given manage on everything; its owner caps it.
    "INSERT INTO grants (id, account_id, scope, level, created_at, updated_at) VALUES ('g5', 'agt_bot', 'all', 'write', 't', 't')",
  ] {
    sqlx::query(statement).execute(db.pool()).await.unwrap();
  }
  db
}

async fn person(
  db: &DbClient,
  id: &str,
) -> AuthIdentity {
  let mut conn = db.pool().acquire().await.unwrap();
  let access = authx::load_access(&mut conn, id, &Features::all())
    .await
    .unwrap()
    .unwrap();
  AuthIdentity::Admin {
    admin_id: id.into(),
    email: format!("{id}@dopbase.com"),
    role: AdminRole::Member,
    session_id: "ses".into(),
    kind: SessionKind::Browser,
    recent_auth_at: chrono::Utc::now(),
    created_at: chrono::Utc::now(),
    csrf_hash: None,
    access,
  }
}

async fn token(
  db: &DbClient,
  id: &str,
  owner: Option<&str>,
  scope: Scope,
  level: Level,
) -> AuthIdentity {
  let mut conn = db.pool().acquire().await.unwrap();
  let access = authx::load_access(&mut conn, id, &Features::all())
    .await
    .unwrap()
    .unwrap();
  AuthIdentity::Token {
    admin_id: id.into(),
    email: id.into(),
    token_id: "ptk".into(),
    token_name: "t".into(),
    access,
    scope,
    level,
    owner_id: owner.map(str::to_owned),
    audit: false,
  }
}

#[tokio::test]
async fn every_principal_reaches_what_its_grants_role_owner_and_token_allow() {
  let db = instance().await;
  let none = Level::None;
  let (metadata, read, write, manage) = (Level::Metadata, Level::Read, Level::Write, Level::Manage);
  // Levels on: dev, prod (protected), cut (excluded), web (no grant).
  let table: Vec<(&str, AuthIdentity, [Level; 4])> = vec![
    (
      "root",
      person(&db, "usr_root").await,
      [manage, manage, manage, manage],
    ),
    (
      "member by project grant",
      person(&db, "usr_member").await,
      [write, none, none, none],
    ),
    (
      "project manager",
      person(&db, "usr_lead").await,
      [manage, manage, manage, none],
    ),
    (
      "auditor capped by role",
      person(&db, "usr_auditor").await,
      [metadata, none, metadata, metadata],
    ),
    (
      "agent capped by its owner",
      token(&db, "agt_bot", Some("usr_member"), Scope::All, write).await,
      [write, none, none, none],
    ),
    (
      "token limited to one environment",
      token(
        &db,
        "usr_member",
        None,
        Scope::Environment("env_dev".into()),
        read,
      )
      .await,
      [read, none, none, none],
    ),
    (
      "token limited to another project",
      token(
        &db,
        "usr_member",
        None,
        Scope::Project("prj_web".into()),
        write,
      )
      .await,
      [none, none, none, none],
    ),
    (
      "runner",
      AuthIdentity::Runner {
        token_id: "tok".into(),
        scope: crate::models::RunnerScope::Environment("env_prod".into()),
      },
      [none, read, none, none],
    ),
  ];
  for (who, identity, expected) in table {
    let mut conn = db.pool().acquire().await.unwrap();
    let reach = Reach::load(&mut conn, &identity).await.unwrap();
    let levels =
      ["env_dev", "env_prod", "env_cut", "env_web"].map(|id| reach.environment(id).unwrap());
    assert_eq!(levels, expected, "{who}");
    // A level of none is hidden, never just denied, so it leaks nothing.
    for (id, level) in ["env_dev", "env_prod", "env_cut", "env_web"]
      .iter()
      .zip(levels)
    {
      let answer = reach.require_environment(id, Level::Write);
      match level {
        Level::None => assert_eq!(answer, Err(Refusal::Hidden), "{who} {id}"),
        level if level < Level::Write => assert_eq!(answer, Err(Refusal::Denied), "{who} {id}"),
        _ => assert!(answer.is_ok(), "{who} {id}"),
      }
    }
  }
}

#[tokio::test]
async fn a_project_shows_through_any_environment_and_hides_the_rest() {
  let db = instance().await;
  let mut conn = db.pool().acquire().await.unwrap();
  let member = Reach::load(&mut conn, &person(&db, "usr_member").await)
    .await
    .unwrap();
  assert_eq!(member.visible_projects(), ["prj_pay"]);
  assert_eq!(member.project("prj_pay"), Some(Level::Write));
  assert_eq!(member.project("prj_web"), None);
  let mut hidden = member.hidden_environments();
  hidden.sort();
  assert_eq!(hidden, ["env_cut", "env_prod"]);

  // A token limited to one environment still shows its project.
  let scoped = Reach::load(
    &mut conn,
    &token(
      &db,
      "usr_member",
      None,
      Scope::Environment("env_dev".into()),
      Level::Read,
    )
    .await,
  )
  .await
  .unwrap();
  assert_eq!(scoped.project("prj_pay"), Some(Level::Metadata));
  assert_eq!(
    scoped.require_project("prj_pay", Level::Write),
    Err(Refusal::Denied)
  );
  assert_eq!(
    scoped.require_project("prj_web", Level::Metadata),
    Err(Refusal::Hidden)
  );
}
