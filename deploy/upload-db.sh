#!/bin/sh
# Put the jobs database on the Fly volume.
#
# Run from the project root, on your laptop, after `fly deploy` has created the
# machine. This is the slow, once-in-a-while step; ordinary code deploys never
# touch it.
#
# What it does, in order:
#   1. VACUUM INTO a compact copy    — reclaims free pages left by the sweeps
#   2. gzip that copy                — SQLite text compresses well, ~3x
#   3. hand you the two upload commands, with the paths filled in
set -e

SRC=data/jobs.db
OUT=data/jobs-deploy.db
GZ=$OUT.gz

if [ ! -f "$SRC" ]; then
  echo "No $SRC here. Run this from the project root." >&2
  exit 1
fi

echo
echo "==> 1/3  Compacting $SRC (this reads the whole database; a few minutes)"
rm -f "$OUT" "$GZ"
# VACUUM INTO writes a fresh, defragmented copy and never modifies the original,
# so the database you use every day is not touched or locked for writing.
sqlite3 "$SRC" "VACUUM INTO '$OUT';"
echo "    $SRC  $(du -h "$SRC" | cut -f1)  ->  $OUT  $(du -h "$OUT" | cut -f1)"

echo
echo "==> 2/3  Compressing (a few minutes)"
gzip -1 "$OUT"
echo "    $GZ  $(du -h "$GZ" | cut -f1)"

echo
echo "==> 3/3  Upload"
cat <<TXT

    Two commands, in this order.

    a) Open an SFTP session and send the file. This is the long one — watch
       your upload speed; roughly 15 minutes per GB on a 10 Mbps connection.

           fly sftp shell

       then at the '»' prompt, one line:

           put $GZ /data/jobs.db.gz

       then Ctrl-D to leave.

    b) Unpack it on the machine and start the app for real:

           fly ssh console

       then at the '#' prompt, one line at a time:

           gunzip /data/jobs.db.gz
           exit

       then back on your laptop:

           fly apps restart

    Then check it came up:

           fly logs

TXT
