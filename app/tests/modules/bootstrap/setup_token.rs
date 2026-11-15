use super::*;

/// A setup claim from `address`, the way a real connection arrives.
async fn claim_from(
  router: &Router,
  address: &str,
  setup_token: &str,
) -> u16 {
  let mut request = Request::builder()
    .method("POST")
    .uri("/api/v1/bootstrap/admin")
    .header(header::CONTENT_TYPE, "application/json")
    .body(Body::from(
      json!({"setupToken":setup_token,"email":"admin@dopbase.com","password":"correct-horse-123"})
        .to_string(),
    ))
    .unwrap();
  request.extensions_mut().insert(axum::extract::ConnectInfo(
    address.parse::<std::net::SocketAddr>().unwrap(),
  ));
  router
    .clone()
    .oneshot(request)
    .await
    .unwrap()
    .status()
    .as_u16()
}

// Security audit N9: five wrong setup tokens from anyone closed setup for
// everyone for 15 minutes, and could be repeated.
#[tokio::test]
async fn wrong_setup_tokens_from_one_address_do_not_close_setup_for_another() {
  let (_dir, state, router) = test_app().await;
  let token = state.setup.read().await.token.clone().unwrap();
  for _ in 0..5 {
    assert_eq!(
      claim_from(&router, "198.51.100.7:4000", "setup_wrong").await,
      401
    );
  }
  // That address is out of tries, even with the right token.
  assert_eq!(claim_from(&router, "198.51.100.7:4000", &token).await, 429);
  // The operator's own address still claims the instance.
  assert_eq!(claim_from(&router, "203.0.113.9:5000", &token).await, 201);
  state.db.close().await;
}

// Many addresses together still meet a shared ceiling.
#[tokio::test]
async fn wrong_setup_tokens_from_many_addresses_meet_a_shared_ceiling() {
  let (_dir, state, router) = test_app().await;
  for index in 0..50 {
    let address = format!("198.51.{}.{}:4000", index / 4, index % 4 + 1);
    assert_eq!(claim_from(&router, &address, "setup_wrong").await, 401);
  }
  let token = state.setup.read().await.token.clone().unwrap();
  assert_eq!(claim_from(&router, "203.0.113.9:5000", &token).await, 429);
  state.db.close().await;
}
