#!/bin/sh
# Put the jobs database on the Fly volume. Run from the project root.
#
# This is the slow, once-in-a-while step; ordinary `fly deploy` code deploys
# never touch it. Fully non-interactive — `fly sftp put` and `fly ssh console -C`
# both take commands directly.
#
#   0. check there is room for all of that, here and on the volume
#   1. VACUUM INTO a compact copy    (your working database is never modified)
#   2. gzip it                        (about a quarter of the size)
#   3. upload it beside the live database, as /data/jobs.db.staging.gz
#   4. unpack and verify it there, then rename it to /data/jobs.db.new
#   5. restart — the entrypoint swaps the verified file in at boot
#
# Since 2026-09-15 the daily pipeline runs this itself as its last stage
# (`src/daily.mjs`, "Publish to the live site"), so it has to be safe to run
# unattended: it must never leave the live site worse than it found it, and
# when it cannot succeed it should say so in seconds, not after an hour of
# upload. The space check is what the second half costs. The corpus outgrew
# the volume's headroom once already — 16 GB compact needs the live copy, the
# archive and the unpacked copy on the volume at the same moment — and the
# only sign was a gunzip that quietly ran out of disk.
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
# copies' worth — which is why the volume is 30 GB and not 6, and why step 0
# measures before step 1 spends anything. `fly volumes extend <id> -s <GB>`
# grows it online when the corpus outgrows it.
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
#
# Every remote call also has a time limit. On 2026-09-15 a plain `df` over
# `fly ssh console` sat for a quarter of an hour with nothing wrong at either
# end. Run by a person that is an annoyance; run by the pipeline it is a
# stage that never ends, and launchd will not start tomorrow's run while
# today's is still going. Three hours covers the unpack and the check, which
# write and read 16 GB through a volume that manages about 7 MB/s; the
# preflight probes get two minutes. perl is on every Mac and `timeout` is
# not, and a pending alarm survives exec, so the signal lands on fly itself.
remote_within() {
  limit=$1
  shift
  perl -e 'alarm shift; exec @ARGV' "$limit" fly ssh console -q -C "$*" </dev/null 2>/dev/null
}
remote() { remote_within 10800 "$@"; }
remote_quick() { remote_within 120 "$@"; }

# The swap is the entrypoint's job, and an image from before it learned to
# swap boots straight past jobs.db.new. Find out now, and decide at the end
# whether a restart is enough or whether a deploy has to do it.
echo
echo "==> 0/5  Checking whether the deployed entrypoint knows how to swap"
if [ "$(remote_quick grep -c 'DB.new' /usr/local/bin/entrypoint.sh | tr -dc '0-9')" = "0" ]; then
  CAN_SWAP=no
  echo "    it does not — the upload will still happen, but the swap will wait for the next deploy"
else
  CAN_SWAP=yes
  echo "    ok"
fi

# Room, before any of it is spent. The compact copy is the database minus its
# free pages; the archive has measured a quarter of that (12.1 GB -> 3.1 GB on
# 2026-08-27) and is budgeted at a third. Locally both sit in data/ at once.
# On the volume the live database stays put while the archive lands beside it
# and unpacks, so the peak there is archive plus compact copy on top of what is
# already used. Both numbers are estimates with headroom, not measurements of
# the file this run will produce.
echo
echo "==> 0/5  Checking there is room"
rm -f "$OUT" "$GZ"
COMPACT_KB=$(sqlite3 "$SRC" "SELECT (page_count - freelist_count) * page_size / 1024 FROM pragma_page_count, pragma_page_size, pragma_freelist_count;")
GZ_KB=$((COMPACT_KB / 3))
gb() { awk -v kb="$1" 'BEGIN { printf "%.1f GB", kb / 1048576 }'; }
LOCAL_NEED_KB=$((COMPACT_KB + GZ_KB))
LOCAL_AVAIL_KB=$(df -k "$(dirname "$SRC")" | awk 'NR == 2 { print $4 }')
if [ "$LOCAL_AVAIL_KB" -lt "$LOCAL_NEED_KB" ]; then
  echo "    Not enough room on this machine: $(gb "$LOCAL_NEED_KB") needed for the compact copy and its archive, $(gb "$LOCAL_AVAIL_KB") free. Free some disk and run this again; the live site is unchanged." >&2
  exit 1
fi
echo "    here:       $(gb "$LOCAL_NEED_KB") needed, $(gb "$LOCAL_AVAIL_KB") free"
REMOTE_NEED_KB=$LOCAL_NEED_KB
REMOTE_AVAIL_KB=$(remote_quick df -k /data | awk 'NR == 2 { print $4 }' | tr -dc '0-9')
if [ -z "$REMOTE_AVAIL_KB" ]; then
  echo "    Could not read the volume's free space over fly ssh within two minutes. Is the app up? The live site is unchanged." >&2
  exit 1
fi
if [ "$REMOTE_AVAIL_KB" -lt "$REMOTE_NEED_KB" ]; then
  VOL=$(fly volumes list --json 2>/dev/null | sed -n 's/.*"id": *"\(vol_[a-z0-9]*\)".*/\1/p' | head -1)
  echo "    Not enough room on the Fly volume: $(gb "$REMOTE_NEED_KB") needed beside the live database, $(gb "$REMOTE_AVAIL_KB") free. Grow it with 'fly volumes extend ${VOL:-<volume id>} -s <GB>' (see docs/deploy.md) and run this again; the live site is unchanged." >&2
  exit 1
fi
echo "    the volume: $(gb "$REMOTE_NEED_KB") needed, $(gb "$REMOTE_AVAIL_KB") free"

echo
echo "==> 1/5  Compacting $SRC (reads the whole database; a few minutes)"
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
# The archive is a few GB on a laptop disk, and the pipeline runs this
# unattended; on success it has nothing left to be for. A failure above exits
# before this line and leaves it, so a retry by hand can skip the compaction.
rm -f "$GZ"
