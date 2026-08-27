# Starred jobs → the tracker spreadsheet

Star a job in the app and a row for it appears in the Google Sheet you already
track applications in. This explains how that works, what it will and will not
touch, and how to set it up.

## The shape of it

The sheet pulls; the app does not push.

A small script lives inside the spreadsheet. Every ten minutes it asks the app
for the list of jobs you have starred, and writes in the ones that are not there
yet. Nothing about Google is known to this codebase — no service account, no
API key, no `googleapis` dependency, nothing in `.env`.

That is the reason to prefer it over the alternative. This repository is public,
and a push from the server would mean a Google credential living somewhere near
it forever. A pull means the only secret in the arrangement is a token that can
read one list and do nothing else — and it lives in your spreadsheet, not here.

The cost is latency: a job you star shows up within ten minutes, not instantly.
For a spreadsheet that records where a job application stands, that is not a
cost anyone can feel.

## Setting it up

**1. Mint a token**, on the machine `data/users.db` is on:

```
node src/accounts.mjs --sync-token=you@example.com
```

It is printed once. Only its SHA-256 is stored, so there is no way to read it
back — losing it means minting another, which is free.

**2. Open the spreadsheet** → Extensions → Apps Script.

**3. Paste in [`integrations/sheet-sync.gs`](../integrations/sheet-sync.gs)**,
replacing whatever is in `Code.gs`. Put the token in `SYNC_TOKEN` near the top.
If you would rather keep it out of the code, put it in Project Settings →
Script Properties under `SYNC_TOKEN` and leave the constant blank.

**4. Run `syncFavourites` once by hand.** Google asks for permission the first
time; it needs to read the sheet and reach the app. Check the rows look right.

**5. Run `installTrigger` once.** From then on it runs itself.

To see whether it is actually running:

```
node src/accounts.mjs --sync-tokens=you@example.com
```

`last used never` on a token you installed a week ago means the trigger is not
firing — which is the failure this arrangement is most likely to have, because
it is the one nothing else would announce.

## What it will not touch

**It never overwrites something you typed.** A tracker is months of work that
exists nowhere else, and a sync that gets this wrong destroys it quietly.

The rule is a three-way comparison rather than a two-way one. Beside each row
the script keeps a record of what it last wrote there, in a `_last_synced`
column. On the next run it may write to a cell only if that cell is empty, or
still holds exactly what the script last put in it. The moment a cell differs
from that record, you have edited it, and the script stops writing that cell for
good.

Comparing only "what the app says" against "what the sheet says" cannot tell
your edit from its own, which is how these things eat people's work. Comparing
against what it last wrote can.

Two consequences worth knowing:

- Rows you typed yourself, before any of this existed, have no record beside
  them and are invisible to the script forever.
- Once you change a status by hand, the app stops updating that cell. That is
  deliberate. If you want the app to drive it again, clear the cell.

`src/sheet-sync-test.mjs` is the guard on all of this, and it runs in `npm test`.

## The two columns it adds

`_job_id` and `_last_synced`, at the far right. The first is what makes a repeat
run recognise a row instead of duplicating it; the second is the record
described above. Hide them if they are in the way — hiding a column does not
affect the script.

## The endpoint

`GET /api/export/saved`, with `Authorization: Bearer <token>` (or `?token=`).

Read-only and deliberately narrow. The token cannot sign in, cannot write, and
cannot reach any other route: `/api/me` answers 401 to it. A session cookie does
not work here either — the two credentials mean different things and neither
stands in for the other.

Unlike a session it has no expiry, because a scheduled job that stops working
after thirty days of silence breaks on the week nobody is watching. Revoke with
`--revoke-sync`; that is the only way it ends.

The response is in the app's own vocabulary — its statuses, its job ids. Turning
`interviewing` into whatever your sheet calls that column is the script's job,
in `STATUS_LABELS`. Otherwise one spreadsheet's wording becomes a fact about the
API.
