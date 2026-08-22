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
