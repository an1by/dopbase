//! AI agents: accounts that sign in with personal tokens only and always
//! have a person who answers for them.
use crate::state::AppState;
use axum::{
  Router,
  routing::{get, post},
};
pub mod controller;
pub mod doc;
pub mod model;
pub mod service;

pub fn routes() -> Router<AppState> {
  use crate::constants::api::agents;
  Router::new()
    .route(
      agents::COLLECTION,
      get(controller::list).post(controller::create),
    )
    .route(
      agents::ITEM,
      get(controller::get)
        .patch(controller::update)
        .delete(controller::delete),
    )
    .route(agents::DISABLE, post(controller::disable))
    .route(agents::ENABLE, post(controller::enable))
    .route(agents::ACCESS, get(controller::access))
    .route(
      agents::TOKENS,
      get(controller::tokens).post(controller::create_token),
    )
    .route(agents::TOKEN_REVOKE, post(controller::revoke_token))
}
