//! OpenID Connect relying party for single sign-on. Dopbase only talks to
//! the provider here: discovery, the authorization redirect, and the code
//! exchange. Provider tokens never leave this module; callers receive the
//! verified identity and nothing else.

use std::{
  fmt,
  sync::Arc,
  time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use openidconnect::{
  AuthorizationCode, ClientId, ClientSecret, CsrfToken, IssuerUrl, Nonce, PkceCodeChallenge,
  PkceCodeVerifier, RedirectUrl, Scope, TokenResponse,
  core::{
    CoreAuthPrompt, CoreAuthenticationFlow, CoreClient, CoreJwsSigningAlgorithm,
    CoreProviderMetadata,
  },
};
use tokio::sync::RwLock;

/// Provider metadata and signing keys are refetched after this long, and
/// once early when a token names a key the cache does not have.
const METADATA_TTL: Duration = Duration::from_secs(60 * 60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// Asymmetric algorithms only. HMAC would make the client secret a signing
/// key, and `none` is never accepted.
const ALLOWED_ALGORITHMS: [CoreJwsSigningAlgorithm; 10] = [
  CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha256,
  CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha384,
  CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha512,
  CoreJwsSigningAlgorithm::RsaSsaPssSha256,
  CoreJwsSigningAlgorithm::RsaSsaPssSha384,
  CoreJwsSigningAlgorithm::RsaSsaPssSha512,
  CoreJwsSigningAlgorithm::EcdsaP256Sha256,
  CoreJwsSigningAlgorithm::EcdsaP384Sha384,
  CoreJwsSigningAlgorithm::EcdsaP521Sha512,
  CoreJwsSigningAlgorithm::EdDsa,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OidcError {
  /// The issuer URL is malformed or its discovery document is unusable.
  Discovery,
  /// The provider refused the authorization code.
  Exchange,
  /// The ID token failed a signature, issuer, audience, expiry, or nonce
  /// check, or was missing.
  InvalidToken,
}

impl OidcError {
  /// A stable reason for audit records and redirects. Never contains
  /// provider output.
  pub fn reason(self) -> &'static str {
    match self {
      Self::Discovery => "provider_unavailable",
      Self::Exchange => "exchange_failed",
      Self::InvalidToken => "invalid_token",
    }
  }
}

impl fmt::Display for OidcError {
  fn fmt(
    &self,
    formatter: &mut fmt::Formatter<'_>,
  ) -> fmt::Result {
    formatter.write_str(self.reason())
  }
}

impl std::error::Error for OidcError {}

/// Decrypted provider settings, held only for the length of one request.
pub struct ProviderSettings {
  pub issuer: String,
  pub client_id: String,
  pub client_secret: String,
}

pub struct AuthorizationRequest {
  pub url: String,
  pub state: String,
  pub nonce: String,
  pub pkce_verifier: String,
}

/// Ask the provider to sign the user in again instead of reusing its own
/// session, for confirming a sensitive action.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Freshness {
  /// Reuse the provider session if there is one.
  Any,
  /// Send `max_age=0`, which OpenID Connect requires providers to honor and
  /// answer with `auth_time`. `prompt_login` also sends `prompt=login`, which
  /// some providers reject.
  Required { prompt_login: bool },
}

pub struct VerifiedIdentity {
  pub issuer: String,
  pub subject: String,
  pub email: Option<String>,
  pub email_verified: bool,
  /// When the user last signed in at the provider (`auth_time`).
  pub authenticated_at: Option<chrono::DateTime<chrono::Utc>>,
  /// The verified token's raw claims, for provider-specific ones the
  /// standard claim set does not model.
  claims: serde_json::Value,
}

impl VerifiedIdentity {
  /// Whether the boolean claim `name` is true. `email_verified` uses the
  /// standard claim; others, such as Microsoft Entra's `xms_edov`, are read
  /// from the raw claims.
  pub fn claim_is_true(
    &self,
    name: &str,
  ) -> bool {
    if name == "email_verified" {
      return self.email_verified;
    }
    self.claims.get(name).is_some_and(|value| {
      *value == serde_json::Value::Bool(true) || value == "1" || value == "true"
    })
  }
}

struct CachedMetadata {
  issuer: String,
  metadata: CoreProviderMetadata,
  fetched: Instant,
}

/// Discovery results shared across requests.
#[derive(Clone, Default)]
pub struct OidcCache {
  inner: Arc<RwLock<Option<CachedMetadata>>>,
}

impl OidcCache {
  /// Forget cached metadata, for example after the provider settings change.
  pub async fn clear(&self) {
    *self.inner.write().await = None;
  }

  async fn metadata(
    &self,
    issuer: &str,
    refresh: bool,
  ) -> Result<CoreProviderMetadata, OidcError> {
    if !refresh
      && let Some(cached) = self.inner.read().await.as_ref()
      && cached.issuer == issuer
      && cached.fetched.elapsed() < METADATA_TTL
    {
      return Ok(cached.metadata.clone());
    }
    let metadata = discover(issuer).await?;
    *self.inner.write().await = Some(CachedMetadata {
      issuer: issuer.to_owned(),
      metadata: metadata.clone(),
      fetched: Instant::now(),
    });
    Ok(metadata)
  }
}

/// Provider requests never follow redirects: a redirect could point the
/// server at an internal address the operator never configured.
fn http_client() -> Result<reqwest::Client, OidcError> {
  reqwest::Client::builder()
    .redirect(reqwest::redirect::Policy::none())
    .timeout(HTTP_TIMEOUT)
    .build()
    .map_err(|_| OidcError::Discovery)
}

/// Fetch and check the discovery document and signing keys. The crate
/// rejects a document whose `issuer` differs from the configured URL.
pub async fn discover(issuer: &str) -> Result<CoreProviderMetadata, OidcError> {
  let issuer = IssuerUrl::new(issuer.to_owned()).map_err(|_| OidcError::Discovery)?;
  let http = http_client()?;
  CoreProviderMetadata::discover_async(issuer, &http)
    .await
    .map_err(|error| {
      tracing::warn!(%error, "OIDC discovery failed");
      OidcError::Discovery
    })
}

pub async fn authorization_request(
  cache: &OidcCache,
  provider: &ProviderSettings,
  redirect_uri: &str,
  freshness: Freshness,
) -> Result<AuthorizationRequest, OidcError> {
  let metadata = cache.metadata(&provider.issuer, false).await?;
  let client = CoreClient::from_provider_metadata(
    metadata,
    ClientId::new(provider.client_id.clone()),
    Some(ClientSecret::new(provider.client_secret.clone())),
  )
  .set_redirect_uri(RedirectUrl::new(redirect_uri.to_owned()).map_err(|_| OidcError::Discovery)?);
  let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
  let mut request = client
    .authorize_url(
      CoreAuthenticationFlow::AuthorizationCode,
      CsrfToken::new_random,
      Nonce::new_random,
    )
    .add_scope(Scope::new("email".into()))
    .add_scope(Scope::new("profile".into()))
    .set_pkce_challenge(challenge);
  if let Freshness::Required { prompt_login } = freshness {
    request = request.set_max_age(Duration::ZERO);
    if prompt_login {
      request = request.add_prompt(CoreAuthPrompt::Login);
    }
  }
  let (url, state, nonce) = request.url();
  Ok(AuthorizationRequest {
    url: url.to_string(),
    state: state.secret().clone(),
    nonce: nonce.secret().clone(),
    pkce_verifier: verifier.secret().clone(),
  })
}

pub async fn exchange(
  cache: &OidcCache,
  provider: &ProviderSettings,
  redirect_uri: &str,
  code: &str,
  pkce_verifier: &str,
  nonce: &str,
) -> Result<VerifiedIdentity, OidcError> {
  let http = http_client()?;
  let metadata = cache.metadata(&provider.issuer, false).await?;
  let client = CoreClient::from_provider_metadata(
    metadata,
    ClientId::new(provider.client_id.clone()),
    Some(ClientSecret::new(provider.client_secret.clone())),
  )
  .set_redirect_uri(RedirectUrl::new(redirect_uri.to_owned()).map_err(|_| OidcError::Discovery)?);
  let response = client
    .exchange_code(AuthorizationCode::new(code.to_owned()))
    .map_err(|_| OidcError::Discovery)?
    .set_pkce_verifier(PkceCodeVerifier::new(pkce_verifier.to_owned()))
    .request_async(&http)
    .await
    .map_err(|error| {
      tracing::warn!(%error, "OIDC code exchange failed");
      OidcError::Exchange
    })?;
  let id_token = response.id_token().ok_or(OidcError::InvalidToken)?;
  let nonce = Nonce::new(nonce.to_owned());

  let verifier = client
    .id_token_verifier()
    .set_allowed_algs(ALLOWED_ALGORITHMS);
  let claims = match id_token.claims(&verifier, &nonce) {
    Ok(claims) => claims.clone(),
    Err(openidconnect::ClaimsVerificationError::SignatureVerification(_)) => {
      // The provider may have rotated its keys since discovery. Refetch
      // once and verify again; a second failure is final.
      let metadata = cache.metadata(&provider.issuer, true).await?;
      let refreshed = CoreClient::from_provider_metadata(
        metadata,
        ClientId::new(provider.client_id.clone()),
        Some(ClientSecret::new(provider.client_secret.clone())),
      );
      let verifier = refreshed
        .id_token_verifier()
        .set_allowed_algs(ALLOWED_ALGORITHMS);
      id_token
        .claims(&verifier, &nonce)
        .map_err(|_| OidcError::InvalidToken)?
        .clone()
    }
    Err(error) => {
      tracing::warn!(%error, "OIDC ID token rejected");
      return Err(OidcError::InvalidToken);
    }
  };

  Ok(VerifiedIdentity {
    issuer: claims.issuer().as_str().to_owned(),
    subject: claims.subject().as_str().to_owned(),
    email: claims.email().map(|email| email.as_str().to_owned()),
    email_verified: claims.email_verified() == Some(true),
    authenticated_at: claims.auth_time(),
    claims: raw_claims(&id_token.to_string()),
  })
}

/// Decode the token's payload. Only called after its signature has been
/// verified.
fn raw_claims(token: &str) -> serde_json::Value {
  token
    .split('.')
    .nth(1)
    .and_then(|payload| URL_SAFE_NO_PAD.decode(payload).ok())
    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    .unwrap_or_default()
}
