#!/bin/sh
# Put the jobs database on the Fly volume. Run from the project root.
#
# This is the slow, once-in-a-while step; ordinary `fly deploy` code deploys
# never touch it. Fully non-interactive — `fly sftp put` and `fly ssh console -C`
# both take commands directly.
#
#   1. VACUUM INTO a compact copy    (your working database is never modified)
#   2. gzip it                        (about a quarter of the size)
#   3. upload it beside the live database, as /data/jobs.db.staging.gz
#   4. unpack and verify it there, then rename it to /data/jobs.db.new
#   5. restart — the entrypoint swaps the verified file in at boot
#
# The staging name is load-bearing. The entrypoint swaps in whatever sits at
# jobs.db.new, on the filename alone — it deletes the live database first and
# verifies nothing, because this script already did. So jobs.db.new must never
# exist unverified, and an upload that dies half way (a dropped ssh session, a
# closed laptop, a machine restart mid-unpack) must leave nothing a later boot
# would trust. Everything up to the last rename happens under a name the
# entrypoint does not know; the rename is on one filesystem and is atomic.
#
# The live site keeps serving the old database until the last step, and a bad
# upload never reaches it: the new file is checked for size, integrity and
# job count before the restart, and deleted if any of them is off. That costs
# room on the volume for both databases plus the archive at once — three
# copies' worth — which is why the volume is 30 GB and not 6.
#
# If the deployed image predates the swap in entrypoint.sh, the script still
# uploads and verifies, and leaves the restart to the next deploy: the
# deploy boots the new entrypoint, and that swaps the file in.
set -e

SRC=data/jobs.db
OUT=data/jobs-deploy.db
GZ=$OUT.gz
REMOTE=/data/jobs.db
NEW=$REMOTE.new
STAGE=$REMOTE.staging
VERIFY=/data/verify-db.mjs

[ -f "$SRC" ] || { echo "No $SRC here. Run this from the project root." >&2; exit 1; }
command -v fly >/dev/null || { echo "flyctl not installed. See docs/deploy.md." >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "sqlite3 not installed." >&2; exit 1; }

# `fly ssh console -C` prints connection chatter of its own and does not
# reliably pass the remote exit status back, so every remote step is checked
# by what it leaves on disk, never by whether the command "succeeded".
remote() { fly ssh console -q -C "$*" 2>/dev/null; }

# The swap is the entrypoint's job, and an image from before it learned to
# swap boots straight past jobs.db.new. Find out now, and decide at the end
# whether a restart is enough or whether a deploy has to do it.
echo
echo "==> 0/5  Checking whether the deployed entrypoint knows how to swap"
if [ "$(remote grep -c 'DB.new' /usr/local/bin/entrypoint.sh | tr -dc '0-9')" = "0" ]; then
  CAN_SWAP=no
  echo "    it does not — the upload will still happen, but the swap will wait for the next deploy"
else
  CAN_SWAP=yes
  echo "    ok"
fi

echo
echo "==> 1/5  Compacting $SRC (reads the whole database; a few minutes)"
rm -f "$OUT" "$GZ"
# VACUUM INTO writes a fresh copy and never modifies or write-locks the original,
# so the database you use every day is untouched.
sqlite3 "$SRC" "VACUUM INTO '$OUT';"
LOCAL_BYTES=$(wc -c < "$OUT" | tr -d ' ')
LOCAL_OPEN=$(sqlite3 "$OUT" "SELECT COUNT(*) FROM jobs WHERE is_open = 1;")
echo "    $(du -h "$SRC" | cut -f1) -> $(du -h "$OUT" | cut -f1), $LOCAL_OPEN open jobs"

echo
echo "==> 2/5  Compressing"
gzip -1 "$OUT"
LOCAL_SHA=$(shasum -a 256 "$GZ" | cut -d' ' -f1)
echo "    $(du -h "$GZ" | cut -f1)  sha256 $LOCAL_SHA"

echo
echo "==> 3/5  Uploading to the volume (the long one)"
remote rm -f "$STAGE.gz" "$STAGE" "$NEW.gz" "$NEW" "$VERIFY"
fly sftp put "$GZ" "$STAGE.gz"
fly sftp put deploy/verify-db.mjs "$VERIFY"
REMOTE_SHA=$(remote sha256sum "$STAGE.gz" | cut -d' ' -f1 | tr -dc 'a-f0-9')
if [ "$REMOTE_SHA" != "$LOCAL_SHA" ]; then
  echo "    Upload did not arrive intact (remote sha256 '$REMOTE_SHA'). The live site is unchanged; run this again." >&2
  remote rm -f "$STAGE.gz"
  exit 1
fi
echo "    sha256 matches"

echo
echo "==> 4/5  Unpacking and verifying on the machine"
remote gzip -d "$STAGE.gz"
RESULT=$(remote node "$VERIFY" "$STAGE" | grep '^{' | tail -1)
echo "    $RESULT"
REMOTE_BYTES=$(printf '%s' "$RESULT" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')
REMOTE_OPEN=$(printf '%s' "$RESULT" | sed -n 's/.*"open":\([0-9]*\).*/\1/p')
case "$RESULT" in *'"quick_check":"ok"'*) ;; *)
  echo "    The unpacked database failed its integrity check. The live site is unchanged." >&2
  remote rm -f "$STAGE" "$STAGE.gz"
  exit 1 ;;
esac
if [ "$REMOTE_BYTES" != "$LOCAL_BYTES" ] || [ "$REMOTE_OPEN" != "$LOCAL_OPEN" ]; then
  echo "    Unpacked database does not match the local copy ($REMOTE_BYTES vs $LOCAL_BYTES bytes, $REMOTE_OPEN vs $LOCAL_OPEN open jobs). The live site is unchanged." >&2
  remote rm -f "$STAGE" "$STAGE.gz"
  exit 1
fi
# Only a database that has passed all three checks ever wears the name the
# entrypoint swaps in.
remote mv "$STAGE" "$NEW"
echo "    verified: $LOCAL_BYTES bytes, $LOCAL_OPEN open jobs — promoted to $NEW"

echo
if [ "$CAN_SWAP" = "yes" ]; then
  echo "==> 5/5  Restarting — the entrypoint swaps $NEW into place at boot"
  fly apps restart
  echo
  echo "==> Done. Checking it came up:"
  fly logs --no-tail 2>&1 | tail -6
else
  echo "==> 5/5  Not restarting: the deployed image predates the swap in deploy/entrypoint.sh."
  echo "    $NEW is verified and waiting on the volume. Push main (or run 'fly deploy');"
  echo "    the deploy boots the new entrypoint, which swaps it in. Then check 'fly logs'."
fi
echo
echo "    Local copy left at $GZ — delete it to reclaim the space."
