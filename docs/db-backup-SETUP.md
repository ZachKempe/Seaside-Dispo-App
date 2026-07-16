# Nightly encrypted database backup — setup & restore

The workflow `.github/workflows/db-backup.yml` runs every night, dumps the entire
Supabase database, encrypts it with AES-256, and stores it as a release asset on a
**separate private repo**. Nothing is stored unencrypted, and nothing lands in this
(public) repo.

It stays dormant until the four secrets below exist, so you can add this file now
and turn it on when ready.

## One-time setup (~15 min, all yours — Claude never enters credentials)

1. **Create a private backup repo.** On GitHub, new repo, e.g. `ZachKempe/seaside-db-backups`,
   visibility **Private**, empty. This is where encrypted dumps land — its releases are
   private because the repo is.

2. **Get the database connection string.** Supabase dashboard → Project → Connect →
   "Connection string" → **URI** tab. Copy the `postgresql://...` string. Use the
   **Session pooler** URI if the direct one is IPv6-only (GitHub runners are IPv4).
   It contains the DB password — treat it as a secret.

3. **Pick a strong passphrase** for the encryption. Generate 30+ random characters and
   **save it in your password manager first** — without it, every backup is unrecoverable.

4. **Create a fine-grained PAT** (GitHub → Settings → Developer settings → Fine-grained
   tokens): repository access limited to the backup repo only, permission
   **Contents: Read and write**. Copy it.

5. **Add four secrets** to *this* repo (Settings → Secrets and variables → Actions → New
   repository secret):

   | Secret | Value |
   |---|---|
   | `SUPABASE_DB_URL` | the `postgresql://...` URI from step 2 |
   | `BACKUP_GPG_PASSPHRASE` | the passphrase from step 3 |
   | `BACKUP_REPO` | `ZachKempe/seaside-db-backups` (or your name) |
   | `BACKUP_REPO_PAT` | the PAT from step 4 |

6. **Run it once manually:** Actions tab → "DB backup (nightly, encrypted)" → Run workflow.
   Confirm a `backup-<timestamp>` release appears in the private repo with a `.dump.gpg`
   asset. Then the nightly schedule takes over.

## Restore (do this once as a drill, then you trust it)

```bash
# 1. Download the encrypted dump from the private repo's Releases (or:)
gh release download backup-<timestamp> --repo ZachKempe/seaside-db-backups

# 2. Decrypt (it will prompt for BACKUP_GPG_PASSPHRASE)
gpg --decrypt seaside-db-<timestamp>.dump.gpg > restore.dump

# 3. Restore into a SCRATCH Supabase project (never the live DB for a drill):
pg_restore --no-owner --no-privileges -d "<scratch-project-connection-uri>" restore.dump
```

Verify row counts match (`select count(*) from buyers;` etc.). A backup you've never
restored is a hope, not a backup — do this drill now and again each quarter.

## Notes

- Retention is 30 days (`RETENTION_DAYS` in the workflow); older releases are pruned each run.
- `pg_dump -Fc` is the compressed custom format → restore with `pg_restore`, not `psql`.
- If you later move to **Supabase Pro** ($25/mo), it includes managed point-in-time backups
  and you can retire this workflow — but keep it until then.
