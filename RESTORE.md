# Backup & restore — recovery runbook

Small homelab service; this documents what's backed up, our targets, and the exact restore steps.
Backups are **proven**, not aspirational: a non-destructive restore drill runs nightly and verifies integrity.

## Targets
- **RPO (max data loss): ~24h.** The DB is snapshotted nightly (03:15). Everything since the last snapshot
  is at risk if the live box is lost. (On-box, WAL keeps the live DB itself crash-consistent.)
- **RTO (time to restore): < 15 min.** Restore = decompress a snapshot, swap the file in, restart the API.

## What's backed up
- **SQLite DB** — `/srv/scripts/backup-mymagicdeck.sh` (jake's cron, `15 3 * * *`): a WAL-safe *online*
  snapshot via better-sqlite3 `.backup()`, gzipped to `/srv/backups/mymagicdeck/`, 14-day retention.
  Contains users, decks, cards, uploads registry, pHash index, FS tree, printings.
- **Upload image files** — `/srv/data/mymagicdeck/uploads/…` are on local disk and are **NOT** in the
  SQLite snapshot. They're covered by the homelab-wide filesystem backup (`/srv/scripts/backup.sh`).
  ⚠️ A DB-only restore brings back the upload *records* but not the image bytes — restore both together.

## Proven restore (drill)
- `/srv/scripts/restore-drill-mymagicdeck.sh` (jake's cron, `40 3 * * *`): decompresses the newest snapshot
  into a scratch copy, runs `PRAGMA integrity_check` + row counts, then deletes it. Logs to
  `/srv/backups/mymagicdeck/restore-drill.log`; exits non-zero on a missing/corrupt backup (wire an alert to that).
  Run it any time: `bash /srv/scripts/restore-drill-mymagicdeck.sh`

## Real restore (DB)
```bash
cd /srv/docker
docker compose stop mymagicdeck-api
cp /srv/data/mymagicdeck/mymagicdeck.db /srv/data/mymagicdeck/mymagicdeck.db.pre-restore   # safety copy
gzip -dc /srv/backups/mymagicdeck/mymagicdeck-<TS>.db.gz > /srv/data/mymagicdeck/mymagicdeck.db
rm -f /srv/data/mymagicdeck/mymagicdeck.db-wal /srv/data/mymagicdeck/mymagicdeck.db-shm    # stale WAL from old db
docker compose start mymagicdeck-api
docker compose exec -T mymagicdeck-api node -e 'require("better-sqlite3")(process.env.DB_PATH,{readonly:true}).prepare("PRAGMA integrity_check").get()' # sanity
```
For a full-box rebuild, also restore `/srv/data/mymagicdeck/uploads/` from the filesystem backup before starting the API.
