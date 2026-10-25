use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Duration;
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub const MAX_EXPIRY_DAYS: i64 = 1095;
pub const EXPIRY_ERROR: &str =
  "Use never or a positive whole number of hours or days, up to 3 years.";

pub fn expiry_duration(value: &str) -> Result<Option<Duration>, &'static str> {
  if value == "never" {
    return Ok(None);
  }
  let (digits, unit) = if let Some(digits) = value.strip_suffix('h') {
    (digits, "h")
  } else if let Some(digits) = value.strip_suffix('d') {
    (digits, "d")
  } else {
    return Err(EXPIRY_ERROR);
  };
  if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
    return Err(EXPIRY_ERROR);
  }
  let amount: i64 = digits.parse().map_err(|_| EXPIRY_ERROR)?;
  let max = match unit {
    "h" => MAX_EXPIRY_DAYS * 24,
    "d" => MAX_EXPIRY_DAYS,
    _ => return Err(EXPIRY_ERROR),
  };
  if amount == 0 || amount > max {
    return Err(EXPIRY_ERROR);
  }
  Ok(Some(if unit == "h" {
    Duration::hours(amount)
  } else {
    Duration::days(amount)
  }))
}

pub fn generate(prefix: &str) -> anyhow::Result<String> {
  let mut bytes = [0_u8; 32];
  getrandom::fill(&mut bytes)?;
  Ok(format!("{prefix}{}", URL_SAFE_NO_PAD.encode(bytes)))
}

pub fn hash(value: &str) -> Vec<u8> {
  Sha256::digest(value.as_bytes()).to_vec()
}

/// The CSRF token a browser session hands to its other tabs. It is derived
/// from the stored hash of the token issued at sign-in, which never leaves
/// the database, so only the server can compute it, and the sign-in tab's
/// own token keeps working.
pub fn tab_csrf(
  prefix: &str,
  csrf_hash: &[u8],
) -> String {
  let mut derived = [0_u8; 32];
  Hkdf::<Sha256>::new(None, csrf_hash)
    .expand(b"dopbase tab csrf v1", &mut derived)
    .expect("32 bytes is a valid HKDF output length");
  format!("{prefix}{}", URL_SAFE_NO_PAD.encode(derived))
}

pub fn constant_time_eq(
  left: &str,
  right: &str,
) -> bool {
  left.as_bytes().ct_eq(right.as_bytes()).into()
}

pub fn public_id(prefix: &str) -> String {
  format!("{prefix}{}", ulid::Ulid::new())
}
