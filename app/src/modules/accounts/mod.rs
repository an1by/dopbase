//! Accounts: what people and AI agents share. Every account has one row in
//! `accounts` and one row with the same id in `users` (a person) or `agents`
//! (an AI agent). Reads go through the `account_profiles` view, which joins
//! them.

use crate::http::HttpError;

/// Which table holds the rest of an account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
  /// A person, in `users`.
  User,
  /// An AI agent, in `agents`.
  Agent,
}

impl Kind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::User => "user",
      Self::Agent => "agent",
    }
  }

  pub fn is_agent(self) -> bool {
    self == Self::Agent
  }

  /// The answer for an id that isn't an account of this kind.
  pub fn not_found(self) -> HttpError {
    match self {
      Self::User => HttpError::not_found("USER_NOT_FOUND", "The user was not found."),
      Self::Agent => HttpError::not_found("AGENT_NOT_FOUND", "The AI agent was not found."),
    }
  }

  /// The kind `id` has to be for an endpoint of this kind to find it, or
  /// `None` when any kind will do. Elsewhere an account of the other kind
  /// counts as missing, so the answer is the one a missing id gets and says
  /// nothing about which kind an id is.
  ///
  /// `me` on the people endpoints is whoever is calling, since every token
  /// reads its own access and tokens there. On the agent endpoints `me` is
  /// found only when the caller is an AI agent.
  pub fn required_for(
    self,
    id: &str,
  ) -> Option<Self> {
    (id != "me" || self.is_agent()).then_some(self)
  }
}
