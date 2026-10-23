use axum::{
  extract::{Request, State},
  middleware::Next,
  response::Response,
};

use crate::{services::audit_chain, state::AppState};

/// Make the instance's retention policy apply to the audit writes a request
/// makes.
pub async fn scope(
  State(state): State<AppState>,
  request: Request,
  next: Next,
) -> Response {
  audit_chain::with_retention(state.config.audit_retention(), next.run(request)).await
}
