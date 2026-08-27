#!/bin/sh
# Container entrypoint. Everything here is about the volume at /data, which is
# the only part of this deployment that is not disposable.
set -e

DB=${JOBS_DB:-/data/jobs.db}
USERS_DB=${USERS_DB:-/data/users.db}

# --------------------------------------------------------------- profiles --
# PROFILE_DIR is <app root>/profiles and is not configurable, so the volume is
# wired in with a symlink rather than a flag. Seed it once from the copy baked
# into the image; after that the volume's copy is authoritative and a profile
# written through the UI survives the next deploy.
if [ ! -d /data/profiles ]; then
  echo "  seeding /data/profiles from the image"
  cp -r /app/profiles-seed /data/profiles
fi
rm -rf /app/profiles
ln -s /data/profiles /app/profiles

# ---------------------------------------------------------- database swap --
# `deploy/upload-db.sh` never touches the live file. It unpacks the new
# database beside it as jobs.db.new, verifies it there, and restarts; the swap
# happens here, at boot, because this is the one moment nothing has the old
# file open. That matters more than it looks: the server runs the database in
# WAL mode, so `jobs.db-wal` holds pages that belong to the *old* file, and
# SQLite would replay them into whatever file is called `jobs.db` when it next
# opens it. Renaming under a running server is how a good upload becomes a
# corrupt database. Here the log goes with the file it belongs to.
if [ -f "$DB.new" ]; then
  echo "  swapping in $DB.new ($(du -h "$DB.new" | cut -f1))"
  rm -f "$DB" "$DB-wal" "$DB-shm" "$DB.new-wal" "$DB.new-shm"
  mv "$DB.new" "$DB"
fi

# -------------------------------------------------------------- database ----
# The jobs database is uploaded by hand, once, and it is not here on the very
# first boot. Idle instead of exiting: a crash-looping machine cannot be reached
# over SFTP, and SFTP is how the database gets here. Exiting would deadlock the
# one step that fixes it.
if [ ! -f "$DB" ]; then
  echo "=============================================================="
  echo "  No jobs database at $DB."
  echo ""
  echo "  From the project root on your laptop, run:"
  echo "      ./deploy/upload-db.sh"
  echo ""
  echo "  Then:  fly apps restart"
  echo ""
  echo "  Idling so this machine stays reachable over SFTP."
  echo "=============================================================="
  exec sleep infinity
fi

echo "  jobs database: $(du -h "$DB" | cut -f1) at $DB"

exec node src/server.mjs \
  --host=0.0.0.0 \
  --port="${PORT:-8080}" \
  --db="$DB" \
  --users-db="$USERS_DB"
