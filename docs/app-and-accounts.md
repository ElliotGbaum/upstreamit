# The app and accounts

What the UpstreamIt web app does beyond the CLI, how the "describe your search" feature is configured and capped, what an account adds, how Google sign-in works, and the security properties the account layer rests on. Measurements below were taken 2026-08-11 to 2026-08-24 unless a later date is given; the live counts are on the site. Figures marked Ashby-only were measured on the 61,213-job corpus of mid-August 2026.

## The app

```bash
npm run serve                    # http://localhost:7799
npm run serve -- --port=8080
npm run serve -- --host=0.0.0.0  # opt in to the network, see "What holds it up"
npm run serve -- --no-accounts   # the server exactly as it was before accounts existed
```

The server binds to `127.0.0.1` unless `--host` is passed. The database holds a full copy of every job description and the API will serve any of them; that is fine on a laptop and not fine on a café network, so exposing it is an explicit flag rather than a default.

`src/server.mjs` serves `app/` and a small JSON API over the filter engine. The profile it posts is the same portable document the CLI and the daily run read (see [filtering.md](./filtering.md)); there is no criterion the page can express that a saved file cannot. Before opening the port it builds the in-memory index — ~3 s on a laptop, ~20 s on the deployed machine — so the first visitor after a restart is never handed a page that appears to hang.

What it does that the CLI does not:

- **Every control carries a live count, and the count is leave-one-out** — how many jobs the search would return if this option were *also* ticked, with the rest of the filters still applied: `New York City (453) · San Francisco Bay Area (613) · Boston (49)` (Ashby-only corpus). With tens of thousands of jobs, someone who picks four criteria blind and lands on zero has no way to tell which one was too narrow; the counts are what make it a tool instead of a guessing game.
- **The options come from the data.** The metro list is the registry the derive pass built from observed location strings, so a corpus that grows a new city grows a new option with no code change. The same rule builds the job-function, seniority, pay-period, skill and ATS lists from `schema.mjs` and the live corpus.
- **The unknown policies are visible controls**, each labelled with the share it affects — the "When a posting doesn't say" panel described in [filtering.md](./filtering.md#every-criterion-has-three-outcomes-not-two).
- **The filter set is a thing the reader can see they own.** The header names the saved search on screen (`FILTER SET · NYC · entry level · solutions & operations`), marks itself *unsaved filters* the moment the filters stop matching it, and saves under a typed name in a small form on the page — which says where the set is going (the account, or `profiles/<name>.json`), what it will be stored as, and whether it updates the set on screen or starts a new one. The menu lists both stores together, each row carrying the document's own name underneath, because two sets can honestly share a label.
- **Every result opens its full audit trail** — the raw location string, which signal decided the workplace (`ats-enum`), which decided the seniority (`title:entry`), whether the salary was as-stated or reinterpreted, and the full description. Plus the link to apply.

The API is six routes: `GET /api/meta`, `POST /api/search`, `GET /api/job/:id`, `GET|PUT|DELETE /api/profiles/:name`, `GET /api/gone`, `POST /api/interpret`. `POST /api/search` takes the same profile document as the CLI. Accounts add `/api/auth/*` and `/api/me/*` on top of those and change none of them. The pages are `/`, `/signin`, `/signup`, `/password` and `/methodology`; sign-in and sign-up are real routes rather than modals.

`PUT /api/profiles/:name` writes `profiles/<name>.json`, which is why the name is checked against a strict pattern rather than trusted into a path join — and why, once the server is reachable from off the machine, writing one requires a session.

## Describe your search

Optional, off by default, and the one thing in the app that needs an account. The panel at the top of the rail takes a sentence — typed or dictated — and sets the forty controls below it:

> *entry-level ops or solutions roles in NYC, I'd take remote too, nothing needing a security clearance*

becomes five title keywords, four title exclusions, `metros: ["nyc"]`, `remote_counts_as_match: true`, a two-year experience cap, `job_functions: ["operations"]` and `exclude_clearance: true` — the same profile document a person would have built by hand, and the same one the CLI and the daily run read. There is no second search path: it writes `profile` and the page redraws. Nothing in `src/lib/interpret.mjs` writes to a file or runs a search; everything the model returns goes through `normalizeProfile`, the same coercion the CLI and the file loader use, so an invalid enum is dropped with a warning rather than saved.

Three behaviours, each a decision rather than an accident:

- **It shows its work and it is one click to undo.** Every criterion it set is listed in the page's own words (`+ metro in nyc`, `− posted within 30 days`), so the reader sees what the *engine* now holds, not the model's account of itself. **Undo** puts back exactly the filters that were there a second before.
- **It cannot exclude a job for staying silent.** The three-outcome rule is the one a language model is most likely to break, because "at least $150k" reads like an instruction to drop everything that doesn't say $150k — and that would discard 74.2% of the market without a word on screen. So the unknown policies are not a field it can write. It gets one narrow list, `exclude_when_unstated`, and the prompt tells it that filling that list in without being asked in so many words is an error.
- **It says what it could not do.** A place it cannot find is named on screen and sets no filter (never a criterion that quietly matches nothing), and anything these filters cannot express — culture, team size, "somewhere I can grow" — comes back as *Couldn't filter on that: …* rather than being approximated with keywords that would narrow the search behind the reader's back.

**The vocabulary is generated, never written down twice.** The tool schema is built from `schema.mjs`'s enums, `SKILL_TERMS` and the live corpus, exactly as `/api/meta` builds the page's dropdowns. A second hand-kept list would drift the day someone added a job function, and the failure is silent: the model confidently returns a value the engine has never heard of and the search comes back empty with no error. Places are the one exception and get a hybrid: the 200 busiest metros are served as ids to pick from — 60.3% of every placed job for 4 KB of prompt (300 buys 3.7 more points for half again as much; 100 gives up 7) — and everything else is free text resolved against the full 24,576-row registry by exact match only. Fuzzy matching was tried and removed: on a registry built from raw location strings it found *something* for every unrecognised word and turned "Germany" into a two-job metro labelled "Germany Berlin". Knowing that "the Bay Area" is `sf-bay` is the model's job; it does it correctly, and a `LIKE` cannot. Input is capped at 4,000 characters — a dictated paragraph is welcome, a pasted resume is not.

**Configuration.** The feature needs an [Anthropic API key](https://console.anthropic.com/settings/keys), and until it has one the panel says so and does nothing else:

```bash
cp .env.example .env     # then paste the key after ANTHROPIC_API_KEY=
npm run serve
```

`.env` is gitignored and read at startup by `src/lib/env.mjs` (`process.loadEnvFile`). A variable already set in the shell wins over the file — environment first, file second, dormant when neither is there, the same precedence as every other config in the project — which is what the deployed copy relies on: `fly secrets set` supplies the key and no `.env` is shipped at all. The alternative is `config/anthropic.json` (gitignored, same as the Google OAuth secret):

```json
{ "api_key": "sk-ant-...", "model": "claude-opus-5" }
```

| variable | default | meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | the key; absent means the feature is off and `/api/meta` says so |
| `ANTHROPIC_MODEL` | `claude-opus-5` | overrides the model; also readable from the config file's `model` |
| `ANTHROPIC_CALLS_PER_HOUR` | `5` | interpretations per account per hour; `0` removes the cap |

A blank value counts as no value at every level. `.env.example` ships with an empty `ANTHROPIC_API_KEY=`, and `process.loadEnvFile` sets a blank name to the empty string rather than leaving it unset, so a `??` fallback would have read the empty string as an answer. Three things would have gone wrong the first time somebody uncommented a line and left it blank: a key in `config/anthropic.json` would be shadowed and the feature would report itself unconfigured; the model would become `''`; and `Number('')` is `0`, which is the value that turns the spending cap **off**. The last one is the reason blank-is-absent exists — a config typo must not silently uncap the only route that spends money.

**Cost.** Each press is one API call. Measured, not estimated: 9,600 input tokens and ~400 output, about 6c on `claude-opus-5` — the tool schema and the 200-metro list dominate the input, so the cost barely moves with how much is typed. At the 5/hour cap that is at most ~29c per account per hour. The Anthropic SDK is the project's only network dependency at *query* time and its only npm dependency at all; with no key set, the server never loads it and the app is exactly what it was.

**Signing in is required for this one panel, and only this one.** It is the single exception to "nothing is behind an account", and the reason is that every press spends real money on the operator's key. That makes *who is asking* a question that has to have an answer: an anonymous caller cannot be capped, cannot be told they have reached their limit, and cannot be told apart from a script. The route was gated on the bind address for a while, which protected the deployed copy and left the laptop open; the bind address is a fact about the socket, and the thing worth knowing is a fact about the person. Signed out, the panel says so and offers the way in; the other forty controls, and every job, count, description and apply link, stay anonymous. The route refuses *before* reading the body — a request that will not be served should not first be allowed to send a megabyte. On a server started with `--no-accounts` the panel is permanently unavailable and says that instead, because there is no sign-in screen to send anyone to.

**The cap is 5 calls per hour per account.** It was 30 — comfortably more than anyone would use in a sitting — and is now a number a person can actually reach: describing a search, reading what it set and rewording it twice is four. That is the trade being made on purpose. The failure it is sized against is not a person being slightly inconvenienced, it is an unattended bill on somebody else's key; the inconvenience is one line in `.env` away from gone while the bill is not. Someone who hits it still has the whole filter rail, which is what the refusal says. The limiter is a sliding window in memory, keyed by the account's email address (a per-socket limit is one NAT away from being shared by an office and one browser restart away from being reset); it resets on restart, the correct trade for a limiter whose job is to cap a runaway rather than to bill accurately. The cap is taken at the line that spends, after every pre-flight check has had its chance to throw, and a failure that provably cost nothing — a rejected key, a model the key cannot reach, no such model, an unreachable API — gives the call back, so mistyping a key does not lock the account out for an hour at the moment someone is trying to fix it. A refused call answers `429`; every other failure answers `400` with a sentence the page shows verbatim, because everything the route can throw is about the request or the configuration, and a client should be able to tell "come back later" from "this will never work".

**Dictation is the browser's, not the app's.** The Speak button is the built-in `SpeechRecognition` API — no key, no dependency, and it does not appear in a browser that lacks it. In Chrome it sends the audio to Google, which is a surprising thing for a tool whose pitch is that it runs on a laptop, so the hint under the button says so.

## Accounts

Optional, and one thing is behind them. Signed out, the app is the app: every job, every filter, every leave-one-out count, every description and every apply link. No nag, no reduced mode, and — with the one exception above — no gate. An anonymous visitor is not a degraded user; they are the default. Everything else an account touches is purely *memory*:

- **Filters, kept.** The working filter document is saved as it changes and restored on return, so a search that took ten minutes to build is still there tomorrow. Named profiles save to the account too, alongside the shared `profiles/*.json` files — the same JSON document either way, listed together in the profile menu.
- **Starred jobs.** A ★ on every result. It changes nothing about the search — a starred job ranks exactly where it always did, with the star filled in so the list tells you which ones are yours — and everything starred is listed under Saved. Signed out it goes to the sign-in screen rather than disappearing, because a control that vanishes teaches nobody what an account is for.
- **Hidden jobs.** A × beside the star, and the one thing an account changes about what a search *returns*. Pressing it takes the row off the list at once, leaving a line naming the job and an Undo, and from the next search on that posting is gone: the account hands the engine a set of ids and the engine subtracts them before it counts anything ([filtering.md](./filtering.md) covers why that is a set of ids and not a criterion). The Hidden tab in the saved view lists them and brings any of them back.
- **What was done about them.** Each saved job carries a status — saved / applied / interviewing / offer / rejected — and a private note.
- **Curated lists.** Any number of named buckets ("dream jobs", "apply this week"), orthogonal to status, because "apply this week" and "applied" answer different questions.

The saved view is *not* a filtered view of the corpus. It shows everything starred, including postings the board has since pulled — tagged `no longer listed`, or `not in this corpus` if the database was rebuilt underneath it. Each saved row carries a snapshot of the title, company and URL taken at save time, so "did I ever apply to this" keeps answering after the posting is gone, which is the whole point of writing it down. The hidden list is drawn the same way, and there the snapshot is not a nicety: a hidden job is missing from every search by construction, so that row is the only copy of its title the screen will ever have.

**A hidden search still says so.** The results line counts the matches it held back — `1,973 matching · 1 hidden by you` — and the count links to the list. It is the same rule the duplicate fold follows: a result set that quietly shrinks is indistinguishable from a filter that went wrong, and the count is of jobs matching *these* filters, not of everything ever hidden. Hiding and starring are independent, because being rejected from a job you applied to is exactly when you want it out of your results and still in your history.

Accounts live in a **second** database, `data/users.db`, and that split is deliberate: `data/jobs.db` is disposable — delete it, re-sweep, re-derive, nothing of value is lost — and it must never contain a password hash, a session token or someone's list of jobs they applied to. An account is the opposite of disposable. Delete `users.db` and the server is the one that existed before accounts. Every query against it lives in `src/lib/users/store.mjs`; the HTTP layer (`routes.mjs`) does parsing, authorization and serialization and nothing else, which is what lets `src/users-test.mjs` drive the store without a socket.

Administration happens from the machine the database is on:

```bash
npm run accounts -- --list               # every account, with what it holds and how it signs in
npm run accounts -- --passwd=<email>     # set a password (prompted with echo off, never a flag)
npm run accounts -- --sessions=<email>   # sign that account out everywhere
npm run accounts -- --delete=<email>     # the account, its saved and hidden jobs, lists and profiles
npm run accounts -- --db=<path>          # a users database somewhere else
```

There is no mail server, so `--passwd` is the reset path. A hosted product resets a password by emailing a link; this is a local app with a SQLite file next to it, so the equivalent authority is *having the file* — the same authority that could read the database directly anyway. Building a mailer to protect a secret that whoever runs the command already has physical access to would be pretending otherwise. Setting a password signs out every existing session. The new password is read from the terminal with echo off rather than from a flag, because an argument lands in shell history and in `ps` output for every other user on the machine. `--delete` prints what it is about to remove and requires the address typed back, because the saved jobs are the one part not recoverable from anywhere else.

## Sign in with Google

Supported, and dormant until configured — with no client id the button is never drawn and the password form is the whole dialog. To turn it on:

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), create an **OAuth client ID** of type *Web application*.
2. Add `http://localhost:7799/api/auth/google/callback` as an authorized redirect URI (Google allows plain `http` for `localhost` only — anything else needs HTTPS).
3. Put the credentials in `config/google-oauth.json` (gitignored), or set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in the environment, and restart the server:

   ```json
   { "client_id": "…apps.googleusercontent.com", "client_secret": "…" }
   ```

   `redirect_uri` is optional in the file. Left out, the callback URL is built from the request the browser actually arrived on, which is right for localhost and wrong behind a proxy that rewrites the host — that is what the override is for.

It is OpenID Connect's authorization-code flow with PKCE (`S256`) and a single-use `state`, not Google Identity Services' one-tap credential. One-tap hands the *browser* an id_token, so the server's only evidence is a JWT that arrived from a page it does not control, and it must then fetch and cache Google's signing keys to believe any of it. The code flow's token exchange happens server-to-server over TLS with the client secret attached, which is both simpler and stronger. The id_token's signature is not re-verified: the token is the response body of a direct TLS request to `oauth2.googleapis.com` authenticated with the client secret, which is the exact case in which OIDC Core §3.1.3.7 says signature validation may be skipped; issuer, audience, expiry and `email_verified` are all checked. An account is linked to an existing one **only** when Google says the address is verified — an unverified assertion is how "sign in with Google" becomes an account takeover, so it is refused rather than guessed.

## What holds it up

`src/lib/users/auth.mjs` has zero dependencies: `node:crypto` has scrypt, a CSPRNG and a timing-safe comparison, which is the whole shopping list.

| | |
| --- | --- |
| Passwords | scrypt, `N=16384, r=8, p=1`, 64-byte key, 16-byte salt — ~95 ms and 16 MB per attempt, invisible on a login form and ruinous for an offline guessing run against a stolen file. Stored as `scrypt$N$r$p$salt$hash`, so raising the parameters later verifies old hashes at their old cost instead of locking anyone out. Passwords are NFKC-normalised, at least 8 characters, and rejected above 1,024 before hashing (scrypt on a 10 MB "password" is a free CPU burn). |
| Sessions | 256 bits of CSPRNG output, base64url, in an `HttpOnly; SameSite=Lax` cookie. The database stores only its SHA-256, so a stolen copy of `users.db` cannot be used to log in as anyone. SHA-256 rather than scrypt is correct here: there is no dictionary to slow an attacker down against. `Secure` is added only when the request arrived over TLS (directly or via `x-forwarded-proto`), because a `Secure` cookie on plain `http://localhost` is simply dropped and the result is a login that appears to succeed and then does nothing. |
| CSRF | `SameSite=Lax` **and** a same-origin check on every write. Neither is trusted alone: `SameSite=Lax` is one browser default away from not stopping a cross-site form post, and the whole cookie-auth failure mode is a page on another origin issuing writes with the cookie attached. A present `Origin` header must match the `Host` the server was reached on; a missing one means a non-browser client — curl, the CLI, a test — which has no ambient cookie to abuse and is allowed through. |
| Enumeration | Wrong password and unknown address return the same message ("that email and password do not match an account") and take the same time — the miss path verifies against a dummy hash so it cannot be timed. |
| Rate limits | Fixed windows in memory, keyed by (client IP, address): login 12 attempts per 15 minutes, signup 6 per hour. A success clears the counter, so normal use never trips it. In memory is the honest scope: one process serving one machine, and a limiter that survived a restart would be a database write on every failed password — the wrong trade for the threat, which is someone grinding a weak password over a coffee-shop network for as long as the server happens to be up. |
| Isolation | Every store function is scoped by `user_id`; no route takes a user id as a parameter, so there is nothing to forge. `/api/me/*` requires a session, applied at one place. A row never leaves the store with a secret in it — `publicUser()` is the only way a user reaches the outside, and `password_hash` is not in it. |

**Over plain HTTP a password is a password in the clear**, and the session cookie that follows it is a bearer token in the clear. The server binds to `127.0.0.1`, where the traffic is between the browser and the same machine. Exposing it with `--host` while keeping accounts on means passwords and session cookies crossing the network unencrypted — put TLS in front of it, or run `--no-accounts`. The startup banner says so out loud. On a non-loopback bind, writing a *shared* `profiles/*.json` also starts requiring a session, since that directory is the one the CLI and the daily run read. The deployed copy sits behind Fly's `force_https` (see [deploy.md](./deploy.md)).
