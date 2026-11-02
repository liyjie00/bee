#!/bin/zsh
# Daily backup of a Bee stack on a macOS server: database dump, uploads and .env,
# kept locally and copied to the NAS. Run by launchd (deploy/bee-backup.plist).
# Settings (env or ~/.config/bee-backup.env): BEE_DIR (live checkout, default ~/Documents/bee),
#              BEE_BACKUP_DIR (local copies, default ~/Documents/bee-backups/daily),
#              BEE_NAS_URL (SMB share, e.g. smb://nas.local/BeeBackups; its password
#              must be in the login keychain: mount it once in Finder with "Remember").
# Keeps BEE_KEEP_LOCAL (7) days here and BEE_KEEP_NAS (30) days on the NAS.
set -euo pipefail
export PATH="$HOME/.orbstack/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

APP="${BEE_DIR:-$HOME/Documents/bee}"
LOCAL="${BEE_BACKUP_DIR:-$HOME/Documents/bee-backups/daily}"
NAS_URL="${BEE_NAS_URL:-}"
KEEP_LOCAL="${BEE_KEEP_LOCAL:-7}"
KEEP_NAS="${BEE_KEEP_NAS:-30}"
[[ -f "$HOME/.config/bee-backup.env" ]] && source "$HOME/.config/bee-backup.env" # survives deploys

stamp=$(date +%F)
out="$LOCAL/$stamp"
mkdir -p "$out"
echo "== $(date '+%F %T') backup to $out"

# Database: custom-format dump (pg_restore can restore all or part of it).
docker exec bee-postgres-1 sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$out/db.dump.tmp"
docker exec -i bee-postgres-1 pg_restore -l < "$out/db.dump.tmp" > /dev/null # a dump that lists is a whole dump
mv "$out/db.dump.tmp" "$out/db.dump"
# Uploaded files, read through the api container that mounts them.
docker exec bee-api-1 tar -C /data/uploads -czf - . > "$out/uploads.tgz"
cp "$APP/.env" "$out/env"
chmod 600 "$out/env"
tail -1 "$APP/.deploys" > "$out/version" 2>/dev/null || true # deployed commit
du -sh "$out" | sed 's/^/   /'
find "$LOCAL" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_LOCAL" -exec rm -rf {} +

[[ -n "$NAS_URL" ]] || { echo "BEE_NAS_URL not set: local copy only"; exit 0; }
share="${NAS_URL##*/}"
mnt=$(mount | awk -v s="/$share on " 'index($0, s) { sub(/.* on /, ""); sub(/ \(.*/, ""); print; exit }')
if [[ -z "$mnt" ]]; then
  # Mounts with the password saved in the keychain; no prompt when run by launchd.
  osascript -e "mount volume \"$NAS_URL\"" > /dev/null
  mnt=$(mount | awk -v s="/$share on " 'index($0, s) { sub(/.* on /, ""); sub(/ \(.*/, ""); print; exit }')
fi
[[ -n "$mnt" && -d "$mnt" ]] || { echo "could not mount $NAS_URL" >&2; exit 1; }
mkdir -p "$mnt/bee"
rsync -rt --delete "$out/" "$mnt/bee/$stamp/"
find "$mnt/bee" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_NAS" -exec rm -rf {} +
echo "   copied to $mnt/bee/$stamp"
