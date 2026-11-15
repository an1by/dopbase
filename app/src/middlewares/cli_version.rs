//! The CLI version floor and the server version header.

use axum::{
  extract::Request,
  http::HeaderValue,
  middleware::Next,
  response::{IntoResponse, Response},
};

use crate::{
  constants::{
    api,
    client::{MIN_CLI_VERSION, VERSION_HEADER},
  },
  services::client_version::require_cli,
};

/// Refuse a CLI older than [`MIN_CLI_VERSION`] before auth runs. Health
/// always answers, so any CLI can still connect and learn the version.
///
/// This sits inside the request ID, trace and security header layers, so the
/// refusal carries the same headers and log line as any other API error.
pub async fn check(
  request: Request,
  next: Next,
) -> Response {
  let path = request.uri().path();
  if path.starts_with(api::PREFIX)
    && path != api::health::ROOT
    && let Err(error) = require_cli(request.headers(), MIN_CLI_VERSION)
  {
    return error.into_response();
  }
  next.run(request).await
}

/// Name the server's version on every API response, including the ones
/// outer layers answer on their own, such as maintenance.
pub async fn version_header(
  request: Request,
  next: Next,
) -> Response {
  let is_api = request.uri().path().starts_with(api::PREFIX);
  let mut response = next.run(request).await;
  if is_api {
    response.headers_mut().insert(
      VERSION_HEADER,
      HeaderValue::from_static(env!("CARGO_PKG_VERSION")),
    );
  }
  response
}
