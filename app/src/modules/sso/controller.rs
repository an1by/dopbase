use super::{error::SsoError, model::*, service};
use crate::{
  constants::api::auth::SSO_CALLBACK,
  extractors::require_mutation,
  http::{HttpResponse, HttpResponseFormat},
  models::AuthIdentity,
  modules::auth::controller::session_cookie,
  state::AppState,
};
use axum::{
  extract::{Query, State},
  http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
  response::{IntoResponse, Response},
};

const BINDING_COOKIE: &str = "dopbase_sso";

/// Path of the binding cookie: every SSO endpoint the browser calls back.
fn binding_path() -> &'static str {
  SSO_CALLBACK
    .rsplit_once('/')
    .map_or(SSO_CALLBACK, |(path, _)| path)
}

/// Ties a sign-in to the browser that started it. Lax, so the provider's
/// top-level redirect back still carries it. `value` is always a token this
/// server generated, never request data.
fn binding_cookie(
  state: &AppState,
  value: Option<&str>,
) -> HeaderValue {
  let secure = if state.config.public_url.starts_with("https://") {
    "; Secure"
  } else {
    ""
  };
  let cookie = match value {
    Some(value) => format!(
      "{BINDING_COOKIE}={value}; Path={}; HttpOnly; SameSite=Lax; Max-Age=600{secure}",
      binding_path()
    ),
    None => format!(
      "{BINDING_COOKIE}=; Path={}; HttpOnly; SameSite=Lax; Max-Age=0{secure}",
      binding_path()
    ),
  };
  HeaderValue::from_str(&cookie).expect("cookie values are token characters")
}

fn read_binding(headers: &HeaderMap) -> Option<String> {
  headers
    .get_all(header::COOKIE)
    .iter()
    .filter_map(|value| value.to_str().ok())
    .flat_map(|cookies| cookies.split(';'))
    .map(str::trim)
    .find_map(|cookie| cookie.strip_prefix("dopbase_sso="))
    .filter(|value| !value.is_empty())
    .map(str::to_owned)
}

fn redirect(
  location: &str,
  cookie: Option<HeaderValue>,
) -> Response {
  let location = HeaderValue::from_str(location).unwrap_or(HeaderValue::from_static("/login"));
  let mut response = (
    StatusCode::FOUND,
    [
      (header::LOCATION, location),
      (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
    ],
  )
    .into_response();
  if let Some(cookie) = cookie {
    response.headers_mut().insert(header::SET_COOKIE, cookie);
  }
  response
}

/// Show single sign-on settings
///
/// Return the configured provider, without its client secret, and the
/// redirect URI to register with it. Root only, from the Admin UI.
#[utoipa::path(
  get,
  path = crate::constants::api::sso::PROVIDER,
  tag = "single sign-on",
  security(("cookieAuth" = [])),
  responses(
    (status = 200, description = "Settings fetched", body = inline(HttpResponseFormat<ProviderSettingsResponse>)),
    (status = 403, description = "Root browser session required", body = crate::http::ErrorBody),
  ),
)]
pub async fn get_provider(
  State(state): State<AppState>,
  identity: AuthIdentity,
) -> Result<HttpResponse<ProviderSettingsResponse>, SsoError> {
  Ok(HttpResponse::ok(
    service::get_provider(&state, &identity).await?,
    "SSO_PROVIDER_FETCHED",
  ))
}

/// Save single sign-on settings
///
/// Create or update the provider after checking its discovery document.
/// Changing the issuer, client ID, or secret disables single sign-on until
/// root completes a new test sign-in. Root only, with recent authentication.
#[utoipa::path(
  put,
  path = crate::constants::api::sso::PROVIDER,
  tag = "single sign-on",
  security(("cookieAuth" = [])),
  request_body = ProviderRequest,
  responses(
    (status = 200, description = "Settings saved", body = inline(HttpResponseFormat<ProviderSettingsResponse>)),
    (status = 403, description = "Root browser session, CSRF, or recent authentication required", body = crate::http::ErrorBody),
    (status = 422, description = "Invalid settings, or the discovery document could not be read", body = crate::http::ErrorBody),
  ),
)]
pub async fn put_provider(
  State(state): State<AppState>,
  headers: HeaderMap,
  identity: AuthIdentity,
  axum::Json(request): axum::Json<ProviderRequest>,
) -> Result<HttpResponse<ProviderSettingsResponse>, SsoError> {
  require_mutation(&identity, &headers)?;
  Ok(HttpResponse::ok(
    service::put_provider(&state, &identity, request).await?,
    "SSO_PROVIDER_SAVED",
  ))
}

/// Turn single sign-on on or off
///
/// Enabling needs a completed test sign-in and an HTTPS public URL. Root
/// only, with recent authentication.
#[utoipa::path(
  put,
  path = crate::constants::api::sso::PROVIDER_ENABLED,
  tag = "single sign-on",
  security(("cookieAuth" = [])),
  request_body = EnabledRequest,
  responses(
    (status = 200, description = "Setting changed", body = inline(HttpResponseFormat<ProviderSettingsResponse>)),
    (status = 403, description = "Root browser session, CSRF, or recent authentication required", body = crate::http::ErrorBody),
    (status = 404, description = "Single sign-on is not configured", body = crate::http::ErrorBody),
    (status = 409, description = "No test sign-in yet, or the public URL is not HTTPS", body = crate::http::ErrorBody),
  ),
)]
pub async fn set_enabled(
  State(state): State<AppState>,
  headers: HeaderMap,
  identity: AuthIdentity,
  axum::Json(request): axum::Json<EnabledRequest>,
) -> Result<HttpResponse<ProviderSettingsResponse>, SsoError> {
  require_mutation(&identity, &headers)?;
  Ok(HttpResponse::ok(
    service::set_enabled(&state, &identity, request.enabled).await?,
    "SSO_PROVIDER_UPDATED",
  ))
}

/// Require single sign-on
///
/// When required, password login is refused for every account except root,
/// which keeps its password as the way back in. Needs single sign-on to be
/// on. Root only, with recent authentication.
#[utoipa::path(
  put,
  path = crate::constants::api::sso::PROVIDER_REQUIRED,
  tag = "single sign-on",
  security(("cookieAuth" = [])),
  request_body = RequiredRequest,
  responses(
    (status = 200, description = "Setting changed", body = inline(HttpResponseFormat<ProviderSettingsResponse>)),
    (status = 403, description = "Root browser session, CSRF, or recent authentication required", body = crate::http::ErrorBody),
    (status = 409, description = "Single sign-on is not on", body = crate::http::ErrorBody),
  ),
)]
pub async fn set_required(
  State(state): State<AppState>,
  headers: HeaderMap,
  identity: AuthIdentity,
  axum::Json(request): axum::Json<RequiredRequest>,
) -> Result<HttpResponse<ProviderSettingsResponse>, SsoError> {
  require_mutation(&identity, &headers)?;
  Ok(HttpResponse::ok(
    service::set_required(&state, &identity, request.required).await?,
    "SSO_PROVIDER_UPDATED",
  ))
}

/// Hide the password form on the login page
///
/// While single sign-on is on, the login page can show only its button.
/// Passwords keep working through the API and the CLI; root reaches the form
/// at `/login?password`. Root only, with recent authentication.
#[utoipa::path(
  put,
  path = crate::constants::api::sso::PROVIDER_PASSWORD_FORM,
  tag = "single sign-on",
  security(("cookieAuth" = [])),
  request_body = PasswordFormRequest,
  responses(
    (status = 200, description = "Setting changed", body = inline(HttpResponseFormat<ProviderSettingsResponse>)),
    (status = 403, description = "Root browser session, CSRF, or recent authentication required", body = crate::http::ErrorBody),
    (status = 404, description = "Single sign-on is not configured", body = crate::http::ErrorBody),
  ),
)]
pub async fn set_password_form(
  State(state): State<AppState>,
  headers: HeaderMap,
  identity: AuthIdentity,
  axum::Json(request): axum::Json<PasswordFormRequest>,
) -> Result<HttpResponse<ProviderSettingsResponse>, SsoError> {
  require_mutation(&identity, &headers)?;
  Ok(HttpResponse::ok(
    service::set_password_form_hidden(&state, &identity, request.hidden).await?,
    "SSO_PROVIDER_UPDATED",
  ))
}

/// Remove single sign-on
///
/// Delete the provider and every linked identity. Accounts keep their
/// passwords. Root only, with recent authentication.
#[utoipa::path(
  delete,
  path = crate::constants::api::sso::PROVIDER,
  tag = "single sign-on",
  security(("cookieAuth" = [])),
  responses(
    (status = 200, description = "Provider removed", body = inline(HttpResponseFormat<serde_json::Value>)),
    (status = 403, description = "Root browser session, CSRF, or recent authentication required", body = crate::http::ErrorBody),
    (status = 404, description = "Single sign-on is not configured", body = crate::http::ErrorBody),
  ),
)]
pub async fn delete_provider(
  State(state): State<AppState>,
  headers: HeaderMap,
  identity: AuthIdentity,
) -> Result<HttpResponse<serde_json::Value>, SsoError> {
  require_mutation(&identity, &headers)?;
  service::delete_provider(&state, &identity).await?;
  Ok(HttpResponse::done("SSO_PROVIDER_DELETED"))
}

/// Start a single sign-on login
///
/// Redirect the browser to the identity provider. Errors redirect to the
/// login page with an `sso_error` reason. No authentication required.
#[utoipa::path(
  get,
  path = crate::constants::api::auth::SSO_START,
  tag = "single sign-on",
  params(StartQuery),
  responses((status = 302, description = "Redirect to the identity provider, or back to the login page")),
)]
pub async fn start(
  State(state): State<AppState>,
  Query(query): Query<StartQuery>,
) -> Response {
  match service::start_login(&state, query.redirect).await {
    Ok(flow) => redirect(
      &flow.authorize_url,
      Some(binding_cookie(&state, Some(&flow.binding))),
    ),
    Err(location) => redirect(&location, Some(binding_cookie(&state, None))),
  }
}

/// Finish a sign-in at the provider
///
/// The provider redirects here. A login continues to the Admin UI handoff
/// page; a link returns to settings or the account page. Failures carry an
/// `sso_error` reason. Only the browser that started the sign-in can use it.
#[utoipa::path(
  get,
  path = crate::constants::api::auth::SSO_CALLBACK,
  tag = "single sign-on",
  params(CallbackQuery),
  responses((status = 302, description = "Redirect into the Admin UI")),
)]
pub async fn callback(
  State(state): State<AppState>,
  headers: HeaderMap,
  Query(query): Query<CallbackQuery>,
) -> Response {
  let binding = read_binding(&headers);
  let location = service::callback(&state, binding.as_deref(), query).await;
  // A successful login still needs the binding for the exchange, and the
  // cookie set by `start` is still valid, so it is left alone. Request data
  // is never echoed back into a Set-Cookie header.
  let cookie = (!location.starts_with(crate::constants::api::sso::HANDOFF_PAGE))
    .then(|| binding_cookie(&state, None));
  redirect(&location, cookie)
}

/// Exchange a single sign-on handoff code
///
/// Trade the one-time code from the handoff page for a browser session.
/// The response matches password login: a session cookie and a CSRF token.
/// No authentication required; the code and binding cookie are the proof.
#[utoipa::path(
  post,
  path = crate::constants::api::auth::SSO_EXCHANGE,
  tag = "single sign-on",
  request_body = ExchangeRequest,
  responses(
    (status = 200, description = "Session started", body = inline(HttpResponseFormat<ExchangeResponse>)),
    (status = 401, description = "The code expired, was used, or belongs to another browser", body = crate::http::ErrorBody),
  ),
)]
pub async fn exchange(
  State(state): State<AppState>,
  headers: HeaderMap,
  axum::Json(request): axum::Json<ExchangeRequest>,
) -> Result<HttpResponse<ExchangeResponse>, SsoError> {
  let binding = read_binding(&headers);
  let result = service::exchange(&state, binding.as_deref(), &request.code).await?;
  Ok(
    HttpResponse::ok(result.response, "LOGIN_SUCCEEDED")
      .with_header(
        HeaderName::from_static("set-cookie"),
        session_cookie(&state, &result.cookie_token)?,
      )
      .with_header(
        HeaderName::from_static("set-cookie"),
        binding_cookie(&state, None),
      ),
  )
}

/// Link single sign-on to the current account
///
/// Return the provider URL to open. After signing in there, the identity is
/// linked to this account. Root uses this as the test sign-in before
/// enabling. Requires a browser session and the CSRF header.
#[utoipa::path(
  post,
  path = crate::constants::api::auth::SSO_LINK,
  tag = "single sign-on",
  security(("cookieAuth" = [])),
  responses(
    (status = 200, description = "Open the returned URL", body = inline(HttpResponseFormat<LinkResponse>)),
    (status = 403, description = "Browser session and CSRF required", body = crate::http::ErrorBody),
    (status = 404, description = "Single sign-on is not enabled", body = crate::http::ErrorBody),
  ),
)]
pub async fn link(
  State(state): State<AppState>,
  headers: HeaderMap,
  identity: AuthIdentity,
) -> Result<HttpResponse<LinkResponse>, SsoError> {
  require_mutation(&identity, &headers)?;
  let flow = service::start_link(&state, &identity).await?;
  Ok(
    HttpResponse::ok(
      LinkResponse {
        authorize_url: flow.authorize_url,
      },
      "SSO_LINK_STARTED",
    )
    .with_header(
      HeaderName::from_static("set-cookie"),
      binding_cookie(&state, Some(&flow.binding)),
    ),
  )
}

/// Show the current account's single sign-on link
#[utoipa::path(
  get,
  path = crate::constants::api::auth::SSO_IDENTITY,
  tag = "single sign-on",
  security(("bearerAuth" = []), ("cookieAuth" = [])),
  responses(
    (status = 200, description = "Link status fetched", body = inline(HttpResponseFormat<IdentityResponse>)),
    (status = 401, description = "Authentication is required", body = crate::http::ErrorBody),
  ),
)]
pub async fn identity(
  State(state): State<AppState>,
  identity: AuthIdentity,
) -> Result<HttpResponse<IdentityResponse>, SsoError> {
  Ok(HttpResponse::ok(
    service::identity_status(&state, &identity).await?,
    "SSO_IDENTITY_FETCHED",
  ))
}

/// Confirm the current user with single sign-on
///
/// Return a provider URL that asks the user to sign in again. When it
/// succeeds, the session counts as recently authenticated, as after a
/// password confirmation. For linked accounts, from the Admin UI.
#[utoipa::path(
  post,
  path = crate::constants::api::auth::SSO_REAUTH,
  tag = "single sign-on",
  security(("cookieAuth" = [])),
  responses(
    (status = 200, description = "Open the returned URL", body = inline(HttpResponseFormat<LinkResponse>)),
    (status = 403, description = "Browser session and CSRF required", body = crate::http::ErrorBody),
    (status = 409, description = "The account has no single sign-on link", body = crate::http::ErrorBody),
  ),
)]
pub async fn reauth(
  State(state): State<AppState>,
  headers: HeaderMap,
  identity: AuthIdentity,
) -> Result<HttpResponse<LinkResponse>, SsoError> {
  require_mutation(&identity, &headers)?;
  let flow = service::start_reauth(&state, &identity).await?;
  Ok(
    HttpResponse::ok(
      LinkResponse {
        authorize_url: flow.authorize_url,
      },
      "SSO_REAUTH_STARTED",
    )
    .with_header(
      HeaderName::from_static("set-cookie"),
      binding_cookie(&state, Some(&flow.binding)),
    ),
  )
}

/// Unlink single sign-on from the current account
///
/// Only for accounts with a password. Requires a browser session, the CSRF
/// header, and recent authentication.
#[utoipa::path(
  delete,
  path = crate::constants::api::auth::SSO_IDENTITY,
  tag = "single sign-on",
  security(("cookieAuth" = [])),
  responses(
    (status = 200, description = "Link removed", body = inline(HttpResponseFormat<serde_json::Value>)),
    (status = 403, description = "Browser session, CSRF, or recent authentication required", body = crate::http::ErrorBody),
    (status = 404, description = "The account has no link", body = crate::http::ErrorBody),
    (status = 409, description = "The account has no password", body = crate::http::ErrorBody),
  ),
)]
pub async fn unlink(
  State(state): State<AppState>,
  headers: HeaderMap,
  identity: AuthIdentity,
) -> Result<HttpResponse<serde_json::Value>, SsoError> {
  require_mutation(&identity, &headers)?;
  service::unlink_self(&state, &identity).await?;
  Ok(HttpResponse::done("SSO_IDENTITY_UNLINKED"))
}
