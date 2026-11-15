use super::support::{Fixture, output, success};

#[tokio::test(flavor = "multi_thread")]
async fn access_shows_an_account_its_grants_and_a_token_its_limit() {
  let fixture = Fixture::new().await;
  fixture.environment().await;
  let root = fixture.json(&["access"]).await;
  assert_eq!(root["roleName"], "Root");
  assert_eq!(root["maxLevel"], "project_manager");

  let project = fixture.json(&["access", "--project", "fixture"]).await;
  assert_eq!(project["environments"][0]["name"], "local");

  // `--user` takes an AI agent's id as well as a person's, though agents
  // have their own endpoint.
  let agent = fixture.agent_token().await;
  let agent_id = agent["token"]["userId"].as_str().unwrap().to_owned();
  let report = fixture.json(&["access", "--user", &agent_id]).await;
  assert_eq!(report["userId"], agent_id.as_str(), "{report}");
  assert_eq!(report["email"], "metadata-agent", "{report}");
  assert_eq!(report["grants"][0]["scopeLabel"], "fixture", "{report}");
  // An id that is neither says so, instead of blaming the agent lookup.
  let missing = fixture.run(&["access", "--user", "usr_missing"]).await;
  assert!(!missing.status.success());
  let text = String::from_utf8_lossy(&missing.stderr);
  assert!(
    text.contains("no person or AI agent has the id usr_missing"),
    "{text}"
  );

  fixture.sign_in_member().await;
  let member = fixture.json(&["access"]).await;
  assert_eq!(member["email"], "member@dopbase.com");
  assert_eq!(member["grants"][0]["scopeLabel"], "fixture");
  assert_eq!(member["grants"][0]["level"], "read");
  assert!(member["token"].is_null());
  let human = fixture.run(&["access"]).await;
  assert!(human.status.success());
  let text = String::from_utf8_lossy(&human.stdout);
  assert!(text.contains("Member (up to manage)"), "{text}");
  assert!(text.contains("direct"), "{text}");

  let created = fixture
    .json(&[
      "token",
      "personal",
      "create",
      "--name",
      "agent",
      "--level",
      "metadata",
      "--project",
      "fixture",
    ])
    .await;
  let mut command = fixture.command();
  command
    .env("DOPBASE_TOKEN", created["plaintextToken"].as_str().unwrap())
    .args(["--json", "access"]);
  let through_token = success(&output(command, None).await);
  assert_eq!(through_token["token"]["name"], "agent");
  assert_eq!(through_token["token"]["level"], "metadata");
  assert_eq!(through_token["token"]["scopeLabel"], "fixture");
  assert!(through_token.get("ownerEmail").is_none(), "{through_token}");

  // An AI agent's report names its owner.
  let mut command = fixture.command();
  command
    .env("DOPBASE_TOKEN", agent["plaintextToken"].as_str().unwrap())
    .arg("access");
  let text = output(command, None).await;
  assert!(text.status.success());
  let text = String::from_utf8_lossy(&text.stdout);
  assert!(text.contains("Owner:"), "{text}");
  assert!(text.contains("names only"), "{text}");
}
