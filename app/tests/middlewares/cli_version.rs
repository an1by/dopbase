use super::*;

/// One request with an optional User-Agent and bearer token, returning the
/// status, the parsed body and the response headers.
async fn send_as(
  router: &Router,
  path: &str,
  user_agent: Option<&str>,
  token: Option<&str>,
) -> (u16, Value, axum::http::HeaderMap) {
  let mut builder = Request::builder().uri(path);
  if let Some(user_agent) = user_agent {
    builder = builder.header(header::USER_AGENT, user_agent);
  }
  if let Some(token) = token {
    builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
  }
  let response = router
    .clone()
    .oneshot(builder.body(Body::empty()).unwrap())
    .await
    .unwrap();
  let status = response.status().as_u16();
  let headers = response.headers().clone();
  let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
  (
    status,
    serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    headers,
  )
}

#[tokio::test]
async fn a_cli_below_the_floor_is_told_to_update_before_auth_runs() {
  let (_directory, state, router, token, _environment_id) = admin_environment().await;
  let version = env!("CARGO_PKG_VERSION");
  for credential in [Some(token.as_str()), None] {
    let (status, body, headers) = send_as(
      &router,
      "/api/v1/projects",
      Some("dopbase/0.1.9"),
      credential,
    )
    .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(
      body["error"]["CLI_UPGRADE_REQUIRED"],
      "This server needs Dopbase CLI 0.2.0 or newer, and this one is 0.1.9. Update it with: curl -fsSL https://dopbase.com/install.sh | sh"
    );
    assert_eq!(headers.get("x-dopbase-version").unwrap(), version);
    // The refusal gets the same headers as any other API error.
    assert_eq!(headers.get("cache-control").unwrap(), "no-store");
    assert_eq!(headers.get("x-content-type-options").unwrap(), "nosniff");
    assert!(headers.get("x-request-id").is_some());
  }
  // Health always answers, so an old CLI can still connect.
  let (status, body, headers) =
    send_as(&router, "/api/v1/health", Some("dopbase/0.1.9"), None).await;
  assert_eq!(status, 200, "{body}");
  assert_eq!(body["data"]["version"], version);
  assert_eq!(headers.get("x-dopbase-version").unwrap(), version);
  state.db.close().await;
}

#[tokio::test]
async fn other_callers_pass_and_every_api_response_names_the_version() {
  let (_directory, state, router, token, _environment_id) = admin_environment().await;
  let version = env!("CARGO_PKG_VERSION");
  let current = format!("dopbase/{version}");
  for user_agent in [
    None,
    Some(current.as_str()),
    Some("curl/8.7.1"),
    Some("dopbase/not-a-version"),
  ] {
    let (status, body, headers) =
      send_as(&router, "/api/v1/projects", user_agent, Some(&token)).await;
    assert_eq!(status, 200, "{user_agent:?}: {body}");
    assert_eq!(headers.get("x-dopbase-version").unwrap(), version);
  }
  // An auth refusal carries the header too.
  let (status, _, headers) = send_as(&router, "/api/v1/projects", None, None).await;
  assert_eq!(status, 401);
  assert_eq!(headers.get("x-dopbase-version").unwrap(), version);
  // Admin UI pages aren't API responses: no floor, no header.
  let (status, _, headers) = send_as(&router, "/", Some("dopbase/0.1.9"), None).await;
  assert_eq!(status, 200);
  assert!(headers.get("x-dopbase-version").is_none());
  state.db.close().await;
}
