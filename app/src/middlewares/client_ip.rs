use std::net::SocketAddr;

use axum::{
  extract::{ConnectInfo, Request, State},
  middleware::Next,
  response::Response,
};

use crate::{services::client_ip, state::AppState};

/// Resolve the client address once per request so audit records can store
/// it. Requests that arrive without connection info, as in-process tests
/// send them, have no address.
pub async fn capture(
  State(state): State<AppState>,
  request: Request,
  next: Next,
) -> Response {
  let peer = request
    .extensions()
    .get::<ConnectInfo<SocketAddr>>()
    .map(|ConnectInfo(address)| address.ip());
  // Proxies may append their own header line instead of extending the
  // existing one; both read as one list.
  let forwarded_for = request
    .headers()
    .get_all("x-forwarded-for")
    .iter()
    .filter_map(|value| value.to_str().ok())
    .collect::<Vec<_>>()
    .join(",");
  let address = client_ip::resolve(
    peer,
    Some(forwarded_for.as_str()).filter(|value| !value.is_empty()),
    &state.config.trusted_proxies,
  );
  client_ip::scope(address, next.run(request)).await
}
