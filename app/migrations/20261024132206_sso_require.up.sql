-- How strongly single sign-on replaces passwords.
-- `require_sso`: password login is refused for every account except root,
-- which keeps its password as the way back in.
-- `hide_password_form`: the Admin UI login page shows only the single sign-on
-- button. Passwords still work through the API and the CLI.
ALTER TABLE sso_providers
  ADD COLUMN require_sso INTEGER NOT NULL DEFAULT 0 CHECK (require_sso IN (0, 1));

ALTER TABLE sso_providers
  ADD COLUMN hide_password_form INTEGER NOT NULL DEFAULT 0 CHECK (hide_password_form IN (0, 1));
