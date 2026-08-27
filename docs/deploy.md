# Deploying to Fly.io

Step-by-step guide to running UpstreamIt on Fly.io: one always-on machine, one volume, deploys from GitHub Actions, and the database uploaded separately by script. Written 2026-08-22 and updated 2026-08-24 for the GitHub Actions deploy that landed on 2026-08-23; sizes and counts below are measurements from those dates (the database grows with every sweep), and the live counts are on the site. Everything here is done from a terminal in the project root.

**Docker is not needed.** Fly builds the image on its own builder.

**Nothing is removed from the database.** Every job (337,487 open jobs when this was
written on 2026-08-22), every full description, and the complete search index go live
exactly as they are.

---

## What gets deployed where

| Piece | Where it ends up | Why |
|---|---|---|
| The code (`src/`, `app/`) | Inside a ~5 MB container image | Small, so deploys take seconds |
| `data/jobs.db` (about 8.4 GB since Workday landed on 2026-08-27; 3.3 GB before it) | On a mounted disk (a Fly "volume") at `/data` | Too big for the image; uploaded once by script |
| `data/users.db` (accounts) | Same volume | Must survive deploys, or people get logged out |
| `profiles/*.json` | Same volume, seeded from the image on first boot | So a profile saved through the UI is not wiped by the next deploy |

`Dockerfile` copies `package.json`, `package-lock.json`, `src/`, `app/`, `profiles/`
(as a seed) and `deploy/entrypoint.sh`, and nothing else; `.dockerignore` keeps `data/`, docs, tests,
`.env` and `config/` out of the image. `deploy/entrypoint.sh` symlinks `/data/profiles`
over the app's profile directory and starts the server, or idles if there is no
database yet (see step 6).

Running cost: the original deployment was estimated at roughly **$11–13/month** on a
2 GB machine (about $10–11 for the machine, about $0.90 for a 6 GB volume). The
machine has since been raised to a 4 GB `shared-cpu-2x` — `fly.toml` explains why —
and the volume to 30 GB on 2026-08-27 (about $4.50 a month at $0.15/GB; step 5 says
why that much), so expect somewhat more. Prices change; check fly.io/pricing.

---

## The app name

`fly.toml` says `app = "job-finder-ats"`. That is the Fly app name, and it is not
the address the site answers on: this deployment is served at <https://upstreamit.io>
(see *A custom domain* below). Fly derives `<app-name>.fly.dev` from the name and
serves that too, but once a custom domain is attached the name is internal
bookkeeping, and changing it would mean creating a new app, so it stays as it is.

App names are global across all of Fly, so this one is taken. **Anyone deploying
their own fork must pick a different, globally-unique name and change that line in
`fly.toml`** before the first deploy. Everything below uses `<your-app-name>` where
the name appears; replace it with whatever was chosen.

---

## Step 1 — Make a Fly account

Go to <https://fly.io/app/sign-up>. A credit card is required even though the first
small amount of usage is free.

## Step 2 — Install the Fly command-line tool

```
brew install flyctl
```

Without Homebrew: `curl -L https://fly.io/install.sh | sh`.

Check it worked:

```
fly version
```

(`deploy/upload-db.sh` exits with a pointer to this step when `fly` is not installed.)

## Step 3 — Log in

```
fly auth login
```

This opens a browser. Log in there, then come back to the terminal.

## Step 4 — Pick a name and create the app

```
fly apps create <your-app-name>
```

Then open `fly.toml` and change the first setting to match:

```
app = "<your-app-name>"
```

While you are in there: `primary_region = "ewr"` is Newark, a good default for the US
East Coast. `fly platform regions` lists the others. The `[[vm]]` block at the bottom
asks for a `shared-cpu-2x` machine with 4 GB of memory — leave it. The filter engine
builds its index in memory at boot, and that is what sizes this machine; a 2 GB one was
OOM-killed on first boot ("Ineffective mark-compacts near heap limit"), and Fly caps
`shared-cpu-1x` at 2 GB.

The index used to cost far more to build than to hold, which is what made 4 GB
necessary. Measured over the same 339,145-job corpus on 2026-08-26, before and after
the two changes in `lib/filter/index.mjs`:

| | Before | After |
| --- | --- | --- |
| Peak heap while building | 1,129 MB | **394 MB** |
| Peak RSS | 1,705 MB | **880 MB** |
| Retained once built | 450 MB | **387 MB** |
| Build time | 3,205 ms | 3,266 ms |

Two independent changes. The peak came down because the index is now streamed out of
SQLite a row at a time (`.iterate()`) instead of being read whole (`.all()`) — the old
way held every raw row and every built row alive at once, which is the entire reason
building a 450 MB index took 1.7 GB. The retained figure came down because `url` and
`apply_url` left the index for the page that actually renders them.

Why it matters beyond tidiness: the corpus is on its way to roughly a million jobs as
Workday lands. Scaled linearly, the old build would have wanted ~5 GB of RSS and been
OOM-killed on this machine; the new one wants ~2.6 GB and fits with room over. Watch
`fly logs` on the first boot after a large sweep and raise `memory` if that projection
turns out optimistic.

## Step 5 — Create the disk

```
fly volumes create jobdata --size 30 --region ewr --app <your-app-name>
```

`jobdata` must match the `source = "jobdata"` line in `fly.toml`, and the region must
match `primary_region`. The size is three databases' worth, not one: the upload
script (step 7) keeps the old database serving until the new one has been unpacked
beside it and verified, so at the peak the volume holds the live database, the
compressed upload and the unpacked copy at once — about 19 GB at the 8.4 GB the
database reached when Workday landed on 2026-08-27. The volume was 6 GB while the
database was 3.3 GB. It can be enlarged later, without a restart, with
`fly volumes extend <volume id> -s <GB>`; it cannot be shrunk.

It will ask for confirmation. Say yes.

## Step 6 — First deploy

The first deploy is easiest done by hand from the laptop:

```
fly deploy
```

This takes a couple of minutes. It uploads about 5 MB of build context, builds the
image on Fly's builder, and starts one machine.

**The app will not work yet, and that is expected.** There is no database on the
volume. Instead of crashing, the entrypoint prints `No jobs database at /data/jobs.db`
and idles — a crash-looping machine cannot be reached over SFTP, and SFTP is how the
database gets there. Confirm it is in that state:

```
fly logs
```

## Step 7 — Upload the database (the slow one)

```
./deploy/upload-db.sh
```

The script is fully non-interactive and does five things:

1. `VACUUM INTO` a compact copy at `data/jobs-deploy.db`. The working `data/jobs.db`
   is never modified or write-locked.
2. `gzip -1` it (roughly a quarter of the size: 8.4 GB → about 2.2 GB).
3. `fly sftp put` the archive to `/data/jobs.db.new.gz` on the volume — *beside* the
   live database, which keeps serving — and check its sha256 against the local copy.
4. Unpack it there and verify it with `deploy/verify-db.mjs` (uploaded alongside, since
   the image has no `sqlite3`): `PRAGMA quick_check`, and the byte size and open-job
   count must equal the local copy's. Anything off and the new file is deleted; the
   live site never sees it.
5. `fly apps restart`. The swap itself happens in `deploy/entrypoint.sh` at boot,
   when nothing has the old file open: it deletes `jobs.db` and its write-ahead log
   and renames `jobs.db.new` into place. The site is down for the restart only.

**Step 3 is the long one.** Upload speed is whatever the local connection gives —
think 15 minutes per GB on a 10 Mbps upload. Start it and go do something else.

The swap is done at boot and not by renaming under the running server for a reason
that is easy to miss: the server keeps the database in WAL mode, so `jobs.db-wal`
holds pages that belong to the *old* file, and SQLite would replay them into
whichever file is called `jobs.db` when it next opens it. The entrypoint deletes the
log together with the file it belongs to. Because the swap lives in the image, the
script first checks that the deployed entrypoint knows about `jobs.db.new` and refuses
to start the upload if the image predates it — push `main` (or `fly deploy`) first.

The three checks exist because both ways an upload fails leave a file that looks
fine: `fly sftp put` has cut a transfer short without saying so, and
`fly ssh console -C` does not reliably pass a failing `gunzip` back. A truncated
database still opens; it just has fewer jobs in it.

The script finishes with `fly apps restart` and prints the last few log lines. If it
has to be done by hand instead, the equivalent is:

```
fly sftp put data/jobs-deploy.db.gz /data/jobs.db.new.gz
fly sftp put deploy/verify-db.mjs /data/verify-db.mjs
fly ssh console -C "gzip -d /data/jobs.db.new.gz"
fly ssh console -C "node /data/verify-db.mjs /data/jobs.db.new"   # must print "quick_check":"ok"
fly apps restart
fly logs
```

The logs should now show a line of the form `<N> open jobs · <M> boards · …` with the
current corpus counts (on 2026-08-22 it read `337,487 open jobs · 15,180 boards`). Then:

```
fly open
```

The site is live at `https://<your-app-name>.fly.dev`. HTTPS is already set up
(`force_https = true` in `fly.toml`); nothing else is needed for it.

The script leaves `data/jobs-deploy.db.gz` behind; delete it to reclaim the space.

## Step 8 — Wire up deploys from GitHub

After the first deploy, code deploys happen from GitHub Actions
(`.github/workflows/deploy.yml`): every push to `main` that changes something the
image actually ships runs `npm test` and then `flyctl deploy --remote-only`. The
workflow needs a Fly API token as a repository secret.

1. Create a deploy token:

   ```
   fly tokens create deploy --app <your-app-name>
   ```

2. In the GitHub repository: Settings → Secrets and variables → Actions → New
   repository secret. Name it `FLY_API_TOKEN` and paste the token.

3. Push to `main`. The `deploy` workflow appears under the Actions tab; it takes a
   few minutes.

Things worth knowing about that workflow:

- **The paths filter is the interesting part.** The workflow only fires for changes
  under `src/`, `app/`, `profiles/`, `deploy/`, `package.json`, `package-lock.json`,
  `Dockerfile`, `.dockerignore`, `fly.toml` and the workflow file itself. The daily
  slug refresh (`daily.yml`, see [automation.md](./automation.md)) commits to `main`
  every morning, and `data/` never reaches the image, so deploying on every push
  would rebuild and restart the machine daily to ship a byte-identical container.
  Adding a `COPY` to the `Dockerfile` means adding its source path to the filter too.
- **`npm test` is the gate.** The tests are self-contained — no network, no API key,
  no `jobs.db` — so they cost about a minute, and they are the only thing standing
  between a bad commit and the public URL.
- **One deploy at a time.** The workflow's concurrency group queues overlapping runs
  rather than cancelling them; two `fly deploy`s racing against one machine end on
  whichever image finishes last, and cancelling mid-release is how a machine gets
  stranded.
- It can also be started by hand from the Actions tab (`workflow_dispatch`), and a
  local `fly deploy` still works; the workflow exists so that pushing and deploying
  are not two separate things to remember.

---

## After the first deploy

**Changing code** is now `git push` to `main`. A deploy takes a few minutes and never
touches the database, the accounts, or the saved profiles.

**Refreshing job data** means re-running the pipeline on the laptop and re-uploading:

```
npm run refresh          # sync slugs, verify boards, sweep all four ATSes, derive
./deploy/upload-db.sh
```

The site's data is frozen between uploads; the page shows when the corpus was last
swept and derived (`swept … · derived …` in `app/app.js`) so the age is visible.

**Profiles on the volume are not updated by deploys.** The entrypoint seeds
`/data/profiles` from the image's copy only when the directory does not exist yet;
after that the volume's copy is authoritative. Editing a JSON file under `profiles/`
in the repo and pushing therefore changes the seed for a *fresh* volume but not the
live profile list. Change live profiles through the UI, or over `fly ssh console`.

**A custom domain** (about $12/year) looks better than `.fly.dev`. This deployment
uses `upstreamit.io`. Buy the name anywhere, then `fly certs add upstreamit.io` and
`fly certs add www.upstreamit.io`, and create the DNS records each command prints;
Fly issues the certificates once those records resolve. `fly certs list` shows
`Issued` when it is done. Add both names, not just the apex — `www` is redirected to
the apex in `src/server.mjs`, and that redirect exists because a session cookie set
on one hostname does not exist on the other.

---

## Things worth knowing

**One machine only.** Each machine gets its own separate volume, so a second one would
have a different accounts database and people would get logged out at random.
`fly.toml` sets `min_machines_running = 1`; do not run `fly scale count 2`.

**Always on.** `auto_stop_machines = "off"` in `fly.toml`. Scale-to-zero would save a
few dollars a month, but the ~3-second index build at boot makes a cold start a visibly
slow first page load — the wrong trade for a link on a résumé.

**Profiles without an `owner` field are visible to every visitor.** Of the profiles
shipped in the repo, `nyc-entry-level.json` carries an `owner` (the original profile,
the author's own search) and is private to that account; `lever-only.json` and
`recent-openings.json` have no owner and appear in everyone's profile list.
`recent-openings.json` also carries `"starter": true`, which is what makes it the profile
the page opens on for a visitor with no saved search — the list is not simply alphabetical.
Remove any scratch profile before deploying.

**The "describe your search" AI feature needs a key, and costs money.** Without a key
it shows as unavailable and the rest of the site is unaffected — that is the safe
default. To turn it on:

```
fly secrets set ANTHROPIC_API_KEY=sk-ant-...
```

`fly secrets set` puts the key in the machine's real environment, which wins over the
gitignored `.env` file used on a laptop (`src/lib/env.mjs`) and over
`config/anthropic.json`; neither of those is in the image.

Before turning it on: that endpoint spends the key owner's API credits. It is the one
route on the site that **requires an account** — signed out, the panel says so and
offers the sign-in button — and it is capped at **5 calls per hour per account**
(`ANTHROPIC_CALLS_PER_HOUR` in `src/lib/interpret.mjs`; `0` turns the cap off). A call
was measured at 9,600 input tokens and ~400 output — about **6¢** on `claude-opus-5`,
the default model (`ANTHROPIC_MODEL` overrides it) — so the cap bounds one account to
roughly 29¢ an hour, worst case.

Sign-up is open, though, so "requires an account" means "requires thirty seconds". The
cap is a cap on a runaway, not a budget: it is a sliding window in memory, it resets
when the machine restarts, and it cannot count accounts nobody has made yet. Set a
spend limit in the Anthropic console as well — that is the thing that is actually a
budget.

```
fly secrets set ANTHROPIC_CALLS_PER_HOUR=10   # optional; the default is 5
```

**Google sign-in is off** in production. `config/google-oauth.json` is gitignored and
`config/` is in `.dockerignore`, so the site offers password sign-in only — which works
fine. To add Google later, `src/lib/users/google.mjs` reads `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` from the environment first, so
`fly secrets set` those three.

**Sign-in security is already correct behind Fly.** Session cookies get the `Secure`
flag automatically because `isSecureRequest` reads `x-forwarded-proto`
(`src/lib/users/auth.mjs:162`), which is exactly what Fly's proxy sets. Anonymous
profile writes are refused when the server is not on localhost.

---

## If something goes wrong

| Symptom | What to do |
|---|---|
| `fly logs` shows "No jobs database" | Step 7 did not finish. Re-run it. |
| Machine keeps restarting | `fly logs` for the real error. Usually out of memory during the index build — `fly.toml` already asks for 4 GB; if it is still short, raise `memory` in the `[[vm]]` block (or `fly scale memory 8192`). |
| Site loads but has no jobs | The upload was cut short and the checks in step 7 were bypassed. Re-run step 7. |
| SFTP disconnects mid-upload | Re-run `./deploy/upload-db.sh`; the upload starts over. |
| "volume not found" on deploy | Volume region must match `primary_region` in `fly.toml`. |
| `fly deploy` rejects `auto_stop_machines = "off"` | Older flyctl. Change it to `false` in `fly.toml`. |
| The Actions deploy fails at "Test" | A test broke; the site is untouched. Fix and push again. |
| The Actions deploy fails at "Deploy" with an auth error | `FLY_API_TOKEN` is missing or expired. Step 8. |
| A push did not deploy at all | Nothing in the paths filter changed. Run the workflow by hand from the Actions tab, or `fly deploy` locally. |
