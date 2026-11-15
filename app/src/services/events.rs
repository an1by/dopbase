//! The audit event catalog: every action Dopbase records, as one type.
//! Writers can only record an action listed here, and readers ask an
//! action what it is (does it change secret values? hand them out?)
//! instead of keeping their own lists of names that go stale.

/// One kind of audit event. The stored name is [`Action::as_str`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Action {
  /// `secret.created`
  SecretCreated,
  /// `secret.updated`
  SecretUpdated,
  /// `secret.deleted`
  SecretDeleted,
  /// `secret.imported`
  SecretImported,
  /// `secret.import_previewed`
  SecretImportPreviewed,
  /// `secret.exported`
  SecretExported,
  /// `secret.revealed`
  SecretRevealed,
  /// `secret.version_revealed`
  SecretVersionRevealed,
  /// `secret.runtime_accessed`
  SecretRuntimeAccessed,
  /// `secret.rolled_back`
  SecretRolledBack,
  /// `secret.copied`
  SecretCopied,
  /// `secret.bulk_copied`
  SecretBulkCopied,
  /// `project.created`
  ProjectCreated,
  /// `project.renamed`
  ProjectRenamed,
  /// `project.deleted`
  ProjectDeleted,
  /// `project.initialized`
  ProjectInitialized,
  /// `environment.created`
  EnvironmentCreated,
  /// `environment.renamed`
  EnvironmentRenamed,
  /// `environment.deleted`
  EnvironmentDeleted,
  /// `environment.protected`
  EnvironmentProtected,
  /// `environment.unprotected`
  EnvironmentUnprotected,
  /// `token.created`
  TokenCreated,
  /// `token.revoked`
  TokenRevoked,
  /// `personal_token.created`
  PersonalTokenCreated,
  /// `personal_token.revoked`
  PersonalTokenRevoked,
  /// `grant.set`
  GrantSet,
  /// `grant.removed`
  GrantRemoved,
  /// `group.created`
  GroupCreated,
  /// `group.updated`
  GroupUpdated,
  /// `group.deleted`
  GroupDeleted,
  /// `group_member.added`
  GroupMemberAdded,
  /// `group_member.removed`
  GroupMemberRemoved,
  /// `role.created`
  RoleCreated,
  /// `role.updated`
  RoleUpdated,
  /// `role.deleted`
  RoleDeleted,
  /// `admin.bootstrapped`
  AdminBootstrapped,
  /// `admin.created`
  AdminCreated,
  /// `admin.updated`
  AdminUpdated,
  /// `admin.deleted`
  AdminDeleted,
  /// `admin.password_changed`
  AdminPasswordChanged,
  /// `admin.password_reset`
  AdminPasswordReset,
  /// `admin.reauthenticated`
  AdminReauthenticated,
  /// `user.enabled`
  UserEnabled,
  /// `user.disabled`
  UserDisabled,
  /// `login.succeeded`
  LoginSucceeded,
  /// `login.failed`
  LoginFailed,
  /// `logout.succeeded`
  LogoutSucceeded,
  /// `sso_login.failed`
  SsoLoginFailed,
  /// `cli_login.approved`
  CliLoginApproved,
  /// `cli_login.denied`
  CliLoginDenied,
  /// `passcode.issued`
  PasscodeIssued,
  /// `sso_provider.created`
  SsoProviderCreated,
  /// `sso_provider.updated`
  SsoProviderUpdated,
  /// `sso_provider.deleted`
  SsoProviderDeleted,
  /// `sso_provider.enabled`
  SsoProviderEnabled,
  /// `sso_provider.disabled`
  SsoProviderDisabled,
  /// `sso_provider.verified`
  SsoProviderVerified,
  /// `sso_provider.policy_changed`
  SsoProviderPolicyChanged,
  /// `sso_identity.linked`
  SsoIdentityLinked,
  /// `sso_identity.unlinked`
  SsoIdentityUnlinked,
  /// `backup.created`
  BackupCreated,
  /// `backup.downloaded`
  BackupDownloaded,
  /// `backup.uploaded`
  BackupUploaded,
  /// `backup.deleted`
  BackupDeleted,
  /// `backup.restored`
  BackupRestored,
  /// `backup.restored_bootstrap`
  BackupRestoredBootstrap,
  /// `master_key.downloaded`
  MasterKeyDownloaded,
  /// `audit.pruned`
  AuditPruned,
}

impl Action {
  /// Every action, in catalog order.
  pub const ALL: [Self; 68] = [
    Self::SecretCreated,
    Self::SecretUpdated,
    Self::SecretDeleted,
    Self::SecretImported,
    Self::SecretImportPreviewed,
    Self::SecretExported,
    Self::SecretRevealed,
    Self::SecretVersionRevealed,
    Self::SecretRuntimeAccessed,
    Self::SecretRolledBack,
    Self::SecretCopied,
    Self::SecretBulkCopied,
    Self::ProjectCreated,
    Self::ProjectRenamed,
    Self::ProjectDeleted,
    Self::ProjectInitialized,
    Self::EnvironmentCreated,
    Self::EnvironmentRenamed,
    Self::EnvironmentDeleted,
    Self::EnvironmentProtected,
    Self::EnvironmentUnprotected,
    Self::TokenCreated,
    Self::TokenRevoked,
    Self::PersonalTokenCreated,
    Self::PersonalTokenRevoked,
    Self::GrantSet,
    Self::GrantRemoved,
    Self::GroupCreated,
    Self::GroupUpdated,
    Self::GroupDeleted,
    Self::GroupMemberAdded,
    Self::GroupMemberRemoved,
    Self::RoleCreated,
    Self::RoleUpdated,
    Self::RoleDeleted,
    Self::AdminBootstrapped,
    Self::AdminCreated,
    Self::AdminUpdated,
    Self::AdminDeleted,
    Self::AdminPasswordChanged,
    Self::AdminPasswordReset,
    Self::AdminReauthenticated,
    Self::UserEnabled,
    Self::UserDisabled,
    Self::LoginSucceeded,
    Self::LoginFailed,
    Self::LogoutSucceeded,
    Self::SsoLoginFailed,
    Self::CliLoginApproved,
    Self::CliLoginDenied,
    Self::PasscodeIssued,
    Self::SsoProviderCreated,
    Self::SsoProviderUpdated,
    Self::SsoProviderDeleted,
    Self::SsoProviderEnabled,
    Self::SsoProviderDisabled,
    Self::SsoProviderVerified,
    Self::SsoProviderPolicyChanged,
    Self::SsoIdentityLinked,
    Self::SsoIdentityUnlinked,
    Self::BackupCreated,
    Self::BackupDownloaded,
    Self::BackupUploaded,
    Self::BackupDeleted,
    Self::BackupRestored,
    Self::BackupRestoredBootstrap,
    Self::MasterKeyDownloaded,
    Self::AuditPruned,
  ];

  /// The name stored in `audit_events.action`.
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::SecretCreated => "secret.created",
      Self::SecretUpdated => "secret.updated",
      Self::SecretDeleted => "secret.deleted",
      Self::SecretImported => "secret.imported",
      Self::SecretImportPreviewed => "secret.import_previewed",
      Self::SecretExported => "secret.exported",
      Self::SecretRevealed => "secret.revealed",
      Self::SecretVersionRevealed => "secret.version_revealed",
      Self::SecretRuntimeAccessed => "secret.runtime_accessed",
      Self::SecretRolledBack => "secret.rolled_back",
      Self::SecretCopied => "secret.copied",
      Self::SecretBulkCopied => "secret.bulk_copied",
      Self::ProjectCreated => "project.created",
      Self::ProjectRenamed => "project.renamed",
      Self::ProjectDeleted => "project.deleted",
      Self::ProjectInitialized => "project.initialized",
      Self::EnvironmentCreated => "environment.created",
      Self::EnvironmentRenamed => "environment.renamed",
      Self::EnvironmentDeleted => "environment.deleted",
      Self::EnvironmentProtected => "environment.protected",
      Self::EnvironmentUnprotected => "environment.unprotected",
      Self::TokenCreated => "token.created",
      Self::TokenRevoked => "token.revoked",
      Self::PersonalTokenCreated => "personal_token.created",
      Self::PersonalTokenRevoked => "personal_token.revoked",
      Self::GrantSet => "grant.set",
      Self::GrantRemoved => "grant.removed",
      Self::GroupCreated => "group.created",
      Self::GroupUpdated => "group.updated",
      Self::GroupDeleted => "group.deleted",
      Self::GroupMemberAdded => "group_member.added",
      Self::GroupMemberRemoved => "group_member.removed",
      Self::RoleCreated => "role.created",
      Self::RoleUpdated => "role.updated",
      Self::RoleDeleted => "role.deleted",
      Self::AdminBootstrapped => "admin.bootstrapped",
      Self::AdminCreated => "admin.created",
      Self::AdminUpdated => "admin.updated",
      Self::AdminDeleted => "admin.deleted",
      Self::AdminPasswordChanged => "admin.password_changed",
      Self::AdminPasswordReset => "admin.password_reset",
      Self::AdminReauthenticated => "admin.reauthenticated",
      Self::UserEnabled => "user.enabled",
      Self::UserDisabled => "user.disabled",
      Self::LoginSucceeded => "login.succeeded",
      Self::LoginFailed => "login.failed",
      Self::LogoutSucceeded => "logout.succeeded",
      Self::SsoLoginFailed => "sso_login.failed",
      Self::CliLoginApproved => "cli_login.approved",
      Self::CliLoginDenied => "cli_login.denied",
      Self::PasscodeIssued => "passcode.issued",
      Self::SsoProviderCreated => "sso_provider.created",
      Self::SsoProviderUpdated => "sso_provider.updated",
      Self::SsoProviderDeleted => "sso_provider.deleted",
      Self::SsoProviderEnabled => "sso_provider.enabled",
      Self::SsoProviderDisabled => "sso_provider.disabled",
      Self::SsoProviderVerified => "sso_provider.verified",
      Self::SsoProviderPolicyChanged => "sso_provider.policy_changed",
      Self::SsoIdentityLinked => "sso_identity.linked",
      Self::SsoIdentityUnlinked => "sso_identity.unlinked",
      Self::BackupCreated => "backup.created",
      Self::BackupDownloaded => "backup.downloaded",
      Self::BackupUploaded => "backup.uploaded",
      Self::BackupDeleted => "backup.deleted",
      Self::BackupRestored => "backup.restored",
      Self::BackupRestoredBootstrap => "backup.restored_bootstrap",
      Self::MasterKeyDownloaded => "master_key.downloaded",
      Self::AuditPruned => "audit.pruned",
    }
  }

  /// The action stored under `name`, if Dopbase knows it.
  pub fn parse(name: &str) -> Option<Self> {
    Self::ALL.into_iter().find(|action| action.as_str() == name)
  }

  /// Whether the event changes or removes stored secret values, so a
  /// backup taken before it is missing something.
  pub const fn changes_secret_values(self) -> bool {
    matches!(
      self,
      Self::SecretCreated
        | Self::SecretUpdated
        | Self::SecretDeleted
        | Self::SecretImported
        | Self::SecretRolledBack
        | Self::SecretCopied
        | Self::SecretBulkCopied
        | Self::ProjectDeleted
        | Self::ProjectInitialized
        | Self::EnvironmentDeleted
    )
  }

  /// Whether the event hands a secret value to someone.
  pub const fn hands_out_secret_values(self) -> bool {
    matches!(
      self,
      Self::SecretExported
        | Self::SecretRevealed
        | Self::SecretVersionRevealed
        | Self::SecretRuntimeAccessed
    )
  }

  /// The quoted names of every action matching `filter`, for an SQL
  /// `IN (...)` list. Built from constant names only.
  pub fn sql_list(filter: impl Fn(Self) -> bool) -> String {
    Self::ALL
      .into_iter()
      .filter(|action| filter(*action))
      .map(|action| format!("'{}'", action.as_str()))
      .collect::<Vec<_>>()
      .join(",")
  }
}

impl std::fmt::Display for Action {
  fn fmt(
    &self,
    formatter: &mut std::fmt::Formatter<'_>,
  ) -> std::fmt::Result {
    formatter.write_str(self.as_str())
  }
}
