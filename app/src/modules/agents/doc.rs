use super::{controller, model::*};
use crate::{
  http::{ErrorBody, HttpResponseFormat},
  modules::{
    grants::model::{GroupRef, UserAccessResponse},
    tokens::personal::model::{
      CreatePersonalTokenRequest, CreatedPersonalTokenResponse, PersonalTokenResponse,
    },
    users::model::UserStatus,
  },
};
use utoipa::OpenApi;

#[derive(OpenApi)]
#[openapi(
  paths(
    controller::list,
    controller::get,
    controller::create,
    controller::update,
    controller::delete,
    controller::disable,
    controller::enable,
    controller::access,
    controller::tokens,
    controller::create_token,
    controller::revoke_token
  ),
  components(schemas(
    AgentResponse,
    CreateAgentRequest,
    UpdateAgentRequest,
    UserStatus,
    GroupRef,
    UserAccessResponse,
    PersonalTokenResponse,
    CreatePersonalTokenRequest,
    CreatedPersonalTokenResponse,
    ErrorBody,
    HttpResponseFormat<Vec<AgentResponse>>,
    HttpResponseFormat<AgentResponse>,
    HttpResponseFormat<serde_json::Value>
  )),
  tags((name = "agents"))
)]
struct AgentsApi;

pub fn build() -> utoipa::openapi::OpenApi {
  AgentsApi::openapi()
}
