# Deploying Job Finder ATS

Everything in this file is done from a terminal, in the project root
(`~/Job Finder ATS`). Each step says what it does and why it exists.

**You do not need Docker.** Fly builds the image on their own servers.

**Nothing is removed from your database.** All 337,487 jobs, all full
descriptions, and the complete search index go live exactly as they are.

---

## What you are building

| Piece | Where it ends up | Why |
|---|---|---|
| Your code (`src/`, `app/`) | Inside a 5 MB container image | Small, so deploys take seconds |
| `data/jobs.db` (3.2 GB) | On a mounted disk ("volume") | Too big for the image; uploaded once |
| `data/users.db` (accounts) | Same volume | Must survive deploys, or people get logged out |
| `profiles/*.json` | Same volume | So a saved profile isn't wiped by the next deploy |

Running cost: roughly **$11–13/month** — about $10–11 for a 2 GB machine and
about $0.90 for a 6 GB volume. Prices change; check fly.io/pricing.

---

## Step 1 — Make a Fly account

Go to <https://fly.io/app/sign-up>. You will have to add a credit card, even
though the first small amount of usage is free. This is normal for them.

## Step 2 — Install the Fly command-line tool

```
brew install flyctl
```

No Homebrew? Use `curl -L https://fly.io/install.sh | sh` instead.

Check it worked:

```
fly version
```

## Step 3 — Log in

```
fly auth login
```

This opens your browser. Log in there, then come back to the terminal.

## Step 4 — Pick a name and create the app

App names are global across all of Fly, so `job-finder-ats` is almost certainly
taken. Pick something unique — `job-finder-elliot`, say.

```
fly apps create job-finder-elliot
```

Then open `fly.toml` and change the first line to match:

```
app = "job-finder-elliot"
```

While you are in there, `primary_region = "ewr"` is Newark. That is a good
default for the US East Coast. `fly platform regions` lists the others.

## Step 5 — Create the disk

```
fly volumes create jobdata --size 6 --region ewr --app job-finder-elliot
```

`jobdata` must match the `source = "jobdata"` line in `fly.toml`, and the region
must match `primary_region`. 6 GB holds the 3.2 GB database plus the compressed
copy during upload, with room to grow. You can enlarge it later with
`fly volumes extend`.

It will ask you to confirm. Say yes.

## Step 6 — First deploy

```
fly deploy
```

This takes a couple of minutes. It uploads about 5 MB, builds the image on
Fly's servers, and starts one machine.

**The app will not work yet, and that is expected.** There is no database on
the volume. Instead of crashing, the machine stays up and idles — a crashing
machine can't be reached over SFTP, and SFTP is how the database gets there.

Confirm it is in that state:

```
fly logs
```

You should see `No jobs database at /data/jobs.db`.

## Step 7 — Upload the database (the slow one)

```
./deploy/upload-db.sh
```

This compacts your database into a fresh copy (your working `data/jobs.db` is
never modified or locked), compresses it, and then prints the two upload
commands with the paths already filled in. Follow what it prints.

**This is the long step.** The compressed file will be somewhere around 1 GB,
and upload speed is whatever your home internet gives you — think 15 minutes
per GB on a 10 Mbps upload. Start it and go do something else.

## Step 8 — Start it for real

The script tells you these, but for reference:

```
fly ssh console
```

That drops you into a shell on the machine, with a `#` prompt. Type:

```
gunzip /data/jobs.db.gz
exit
```

Back on your laptop:

```
fly apps restart job-finder-elliot
fly logs
```

In the logs you should now see `337,487 open jobs · 15,180 boards`.

Then:

```
fly open
```

Your site is live at `https://job-finder-elliot.fly.dev`. HTTPS is already set
up; you don't have to do anything for it.

---

## After the first deploy

**Changing code** is now just `fly deploy`. It takes seconds and does not
re-upload the database.

**Refreshing job data** means re-running the sweep on your laptop and
re-uploading:

```
npm run refresh
./deploy/upload-db.sh
```

Since the site's data is frozen between uploads, put a "data as of [date]" line
somewhere in the UI so it is honest.

**A custom domain** (about $12/year) looks better on a résumé than
`.fly.dev`. Buy one anywhere, then `fly certs add jobfinder.dev` and follow
what it prints.

---

## Things worth knowing

**One machine only.** Each machine gets its own separate volume, so a second
one would have a different accounts database and people would get logged out at
random. `fly.toml` is set for one; don't run `fly scale count 2`.

**`profiles/Lever-Only.json` has no `owner` field**, which means every visitor
sees it in the profile list. `nyc-entry-level.json` is owned by you, so it stays
private. If Lever-Only was a scratch file, delete it before deploying.

**The "describe your search" AI feature needs a key, and costs money.** Your
other Claude session added it while I was working. Without a key it simply
shows as unavailable and the rest of the site is unaffected — that is the safe
default, and I would leave it that way at first. To turn it on:

```
fly secrets set ANTHROPIC_API_KEY=sk-ant-...
```

Before you do: that endpoint spends *your* API credits. It is the one route on
the site that **requires an account** — signed out, the panel says so and offers
the sign-in button, and the rest of the site is untouched — and it is capped at
**5 calls per hour per account** (`ANTHROPIC_CALLS_PER_HOUR`). A call measures
9,600 input tokens and ~400 output — about **6c** on `claude-opus-5` — so the
cap bounds one account to roughly 29c an hour, worst case.

Sign-up is open, though, so "requires an account" means "requires thirty
seconds". The cap is a cap on a runaway, not a budget: it resets when the machine
restarts, and it cannot count accounts nobody has made yet. Set a spend limit in
the Anthropic console as well — that is the thing that is actually a budget.

```
fly secrets set ANTHROPIC_CALLS_PER_HOUR=10   # optional; the default is 5
```

**Google sign-in is off** in production. `config/google-oauth.json` is
gitignored and not in the image, so the site offers password sign-in only —
which works fine. To add Google later, use `fly secrets set`.

**Sign-in security is already correct behind Fly.** Session cookies get the
`Secure` flag automatically because `isSecureRequest` reads `x-forwarded-proto`
(`src/lib/users/auth.mjs:162`), which is exactly what Fly's proxy sets. And
anonymous profile writes are already refused when the server isn't on localhost.

---

## If something goes wrong

| Symptom | What to do |
|---|---|
| `fly logs` shows "No jobs database" | Step 7 didn't finish. Re-run it. |
| Machine keeps restarting | `fly logs` for the real error. Usually out of memory — `fly scale memory 4096`. |
| Site loads but has no jobs | The upload was cut short. Re-run step 7. |
| SFTP disconnects mid-upload | Re-run `fly sftp shell` and `put` again; it starts over. |
| "volume not found" on deploy | Volume region must match `primary_region` in `fly.toml`. |
| `fly deploy` rejects `auto_stop_machines = "off"` | Older flyctl. Change it to `false` in `fly.toml`. |
