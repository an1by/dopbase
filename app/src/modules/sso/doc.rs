use super::{controller, model::*};
use crate::{
  http::{ErrorBody, HttpResponseFormat},
  modules::auth::model::LoginResponse,
};
use utoipa::OpenApi;
#[derive(OpenApi)]
#[openapi(paths(controller::get_provider,controller::put_provider,controller::set_enabled,controller::set_required,controller::set_password_form,controller::reauth,controller::unlink,controller::delete_provider,controller::start,controller::callback,controller::exchange,controller::link,controller::identity),components(schemas(SsoPreset,ProviderRequest,ProviderView,ProviderSettingsResponse,EnabledRequest,RequiredRequest,PasswordFormRequest,ExchangeRequest,ExchangeResponse,LinkResponse,IdentityResponse,LoginResponse,ErrorBody,HttpResponseFormat<ProviderSettingsResponse>,HttpResponseFormat<ExchangeResponse>,HttpResponseFormat<LinkResponse>,HttpResponseFormat<IdentityResponse>,HttpResponseFormat<serde_json::Value>)),tags((name="single sign-on")))]
struct SsoApi;
pub fn build() -> utoipa::openapi::OpenApi {
  SsoApi::openapi()
}
