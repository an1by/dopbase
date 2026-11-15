use super::*;

#[tokio::test]
async fn runner_token_names_follow_the_environment_name_rule() {
  let (_directory, state, router, admin, environment_id) = admin_environment().await;
  let path = format!("/api/v1/environments/{environment_id}/tokens");
  let long = "a".repeat(64);
  for name in [
    "deploy prod",
    "Deploy",
    "2-deploy",
    "deploy_prod",
    "deploy--prod",
    "",
    long.as_str(),
  ] {
    let (status, body, _) = call(
      &router,
      "POST",
      &path,
      Some(&admin),
      Some(json!({"name": name, "role": "runner"})),
    )
    .await;
    assert_eq!(status, 422, "{name:?}: {body}");
    assert!(
      body["error"]["TOKEN_NAME_INVALID"].is_string(),
      "{name:?}: {body}"
    );
  }

  // Surrounding spaces are trimmed, as before.
  let (status, body, _) = call(
    &router,
    "POST",
    &path,
    Some(&admin),
    Some(json!({"name": " deploy-prod ", "role": "runner"})),
  )
  .await;
  assert_eq!(status, 201, "{body}");
  assert_eq!(body["data"]["token"]["name"], "deploy-prod");
  state.db.close().await;
}

// Security audit N3: a runner token kept working after the person who made
// it left. Now it stops while they are turned off and goes when they're
// deleted.
#[tokio::test]
async fn a_runner_token_lasts_only_as_long_as_its_maker() {
  use super::grants_access::{As, grant, instance, person, send};
  let (_dir, state, router) = test_app().await;
  let (root, env) = instance(&state, &router).await;
  let dev = env["payments/dev"].clone();
  let lead = person(&router, &root, "lead@dopbase.com", "member").await;
  grant(
    &router,
    &root,
    ("user", &lead.id),
    ("project", Some("payments")),
    "manage",
  )
  .await;
  let (status, body) = send(
    &router,
    "POST",
    &format!("/api/v1/environments/{dev}/tokens"),
    lead.cli(),
    Some(json!({"name":"ci","role":"runner"})),
  )
  .await;
  assert_eq!(status, 201, "{body}");
  let raw = body["data"]["plaintextToken"].as_str().unwrap().to_owned();
  let fetch = |raw: String| {
    let router = router.clone();
    async move {
      send(
        &router,
        "GET",
        "/api/v1/runtime/secrets",
        As::Token(&raw),
        None,
      )
      .await
      .0
    }
  };
  assert_eq!(fetch(raw.clone()).await, 200);
  let (status, body) = send(
    &router,
    "POST",
    &format!("/api/v1/users/{}/disable", lead.id),
    root.browser(),
    None,
  )
  .await;
  assert_eq!(status, 200, "{body}");
  assert_eq!(fetch(raw.clone()).await, 401);
  let (status, body) = send(
    &router,
    "DELETE",
    &format!("/api/v1/users/{}", lead.id),
    root.browser(),
    None,
  )
  .await;
  assert_eq!(status, 200, "{body}");
  let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM runner_tokens")
    .fetch_one(state.db.pool())
    .await
    .unwrap();
  assert_eq!(left, 0);
}
