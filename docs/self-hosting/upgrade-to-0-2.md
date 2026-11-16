---
title: "Upgrade to 0.2.0"
description: "Move a Dopbase 0.1.x instance to 0.2.0: back up on 0.1.x, install 0.2.0 fresh, and restore. Restore upgrades the old backup."
---

# Upgrade to 0.2.0

Dopbase 0.2.0 stores its data in a new shape. You can't point the 0.2.0
binary at a 0.1.x data directory: it refuses to start and tells you to back
up first. Instead, you take a backup on 0.1.x and restore it into a fresh
0.2.0 instance. Restore notices the backup is from 0.1.x and upgrades it on
the way in.

Don't skip this release. We plan to drop 0.1.x restores in 0.3.0, so a 0.1.x
instance has to move to 0.2.x before it can move to 0.3.0.

## Steps

1. On 0.1.x, take a backup and save it to the current folder:

   ```bash
   dopbase backup before-0-2 --output ./before-0-2.dop
   ```

   Then download the master key from the **Backups** page, or copy
   `~/.dopbase/master.key`. Keep the key somewhere other than the backup.

2. Install 0.2.0 and start it on a new, empty data directory. Leave the 0.1.x
   directory as it is until you have checked the new instance.

3. Restore the backup with the key it was made with:

   ```bash
   dopbase restore ./before-0-2.dop --key ./master.key --setup-token <token>
   ```

   Use the setup token the new server printed. The Admin UI's setup screen and
   the **Backups** page take 0.1.x backups too.

4. Sign in again. Sessions don't carry over, so every person signs in once
   more, and CLI users run `dopbase login`.

## Install previous version

Forgot backup previous secrets?, dont worry and dont delete your
dopbase home folder, what you need is just install previous version, backup
what you need, install new version and restore.

```bash
# Set version before run installation
export DOPBASE_VERSION=0.1.10

# Run installation, it will select previous version
curl -fsSL https://dopbase.com/install.sh | sh

# Once finish with backup, unset and install normal version
unset DOPBASE_VERSION
```

## What comes across

Everything that has a place in 0.2.0: accounts, roles, groups, grants,
projects, environments, secrets with their history, runner tokens, personal
tokens, AI agents and their tokens, single sign-on settings, the audit log, workspaces, project locations, and workspace runner tokens (fork). Plain 0.1.x backups get a default workspace. Token values keep working, except personal tokens older than their role
allows (see below), and secrets are re-keyed to the new instance's master
key.

When restore finishes, it reports what it left out and changed.

It leaves out rows that name something deleted before the backup, such as a
grant on a deleted environment or a token limited to a deleted project. Sign-in
state (sessions, sign-in flows, device requests and passcodes) doesn't come
across either.

0.2.0 refuses a personal token once it is older than its role's longest token
lifetime, so restore moves each token's expiry to that point at the latest,
counted from when the token was made. A token that is already older comes
across expired, and you make a new one. Runner tokens always expire in 0.2.0, so one that never
expired, or was set to expire more than a year out, now expires 365 days
after the restore. A secret whose two stored copies disagreed keeps the value
0.1.x was serving.

AI agents move out of the people list. Each keeps its id, name, owner, access
and tokens, and shows up under **AI agents** and at `/api/v1/agents`. An agent
whose owner was deleted now belongs to root.

Audit records written before 0.1.x had a tamper-evident chain can't be sealed
after the fact, so restore saves them as JSON lines in the audit archive folder
instead. Uploading a 0.1.x backup on **Backups** upgrades it but keeps those
records inside the stored file; they reach the folder when you restore it.
Every chained record comes across unchanged, and the chain still verifies.

The restore's audit record carries the same report: `backup.restored`, or
`backup.restored_bootstrap` when you restore during setup.

## If something goes wrong

If any step fails, restore stops before it touches the running instance and
says which step failed. Your 0.1.x data directory is never changed, so you
can start the old binary on it again at any time.

Restore runs up to 15 minutes before the request times out, which covers
large instances. Runner tokens from 0.1.x don't record who made them, so
they keep working until you revoke them or they expire; tokens you make on
0.2.0 stop when the person who made them is removed or turned off.

0.1.x can't restore a backup made by 0.2.0. It refuses the file and changes
nothing, but the error can read like a key problem: 0.1.10 answers
`BACKUP_REKEY_FAILED` with "no such column: version" in the details. If you
need to go back to 0.1.x, restore a backup you took on 0.1.x.
