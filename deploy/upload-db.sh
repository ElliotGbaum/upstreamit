#!/bin/sh
# Put the jobs database on the Fly volume. Run from the project root.
#
# This is the slow, once-in-a-while step; ordinary `fly deploy` code deploys
# never touch it. Fully non-interactive — `fly sftp put` and `fly ssh console -C`
# both take commands directly.
#
#   1. VACUUM INTO a compact copy    (your working database is never modified)
#   2. gzip it                        (~3.3 GB -> ~865 MB)
#   3. upload it to the volume
#   4. unpack and restart
set -e

SRC=data/jobs.db
OUT=data/jobs-deploy.db
GZ=$OUT.gz
REMOTE=/data/jobs.db

[ -f "$SRC" ] || { echo "No $SRC here. Run this from the project root." >&2; exit 1; }
command -v fly >/dev/null || { echo "flyctl not installed. See DEPLOY.md step 2." >&2; exit 1; }

echo
echo "==> 1/4  Compacting $SRC (reads the whole database; a few minutes)"
rm -f "$OUT" "$GZ"
# VACUUM INTO writes a fresh copy and never modifies or write-locks the original,
# so the database you use every day is untouched.
sqlite3 "$SRC" "VACUUM INTO '$OUT';"
echo "    $(du -h "$SRC" | cut -f1) -> $(du -h "$OUT" | cut -f1)"

echo
echo "==> 2/4  Compressing"
gzip -1 "$OUT"
echo "    $(du -h "$GZ" | cut -f1)"

echo
echo "==> 3/4  Uploading to the volume (the long one)"
fly sftp put "$GZ" /data/jobs.db.gz

echo
echo "==> 4/4  Unpacking"
# The volume cannot hold the old database and the new one at once (6 GB, and
# each copy is ~3.3 GB), and space is not reclaimed by deleting a file the
# running server still has open. So: drop the old one, restart into the
# entrypoint's idle branch (which releases the handle and frees the space),
# unpack, then restart for real. The site is down for the unpack only.
if fly ssh console -C "test -f $REMOTE" >/dev/null 2>&1; then
  echo "    replacing the existing database — the site will be down for a minute"
  fly ssh console -C "rm -f $REMOTE"
  fly apps restart          # boots into "no database", releasing the old handle
fi

fly ssh console -C "gunzip -f /data/jobs.db.gz"
fly apps restart

echo
echo "==> Done. Checking it came up:"
fly logs --no-tail 2>&1 | tail -6
echo
echo "    Local copy left at $GZ — delete it to reclaim the space."
