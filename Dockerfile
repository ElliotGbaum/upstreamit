# UpstreamIt — container image.
#
# There is no build step. There is one small install step: the "describe your
# search" feature pulls in @anthropic-ai/sdk, and everything else the app needs
# is a Node built-in (SQLite included, as `node:sqlite`).
#
# What is deliberately *not* in here is the jobs database. At several gigabytes it
# would turn every one-line CSS fix into a multi-gigabyte upload, so it lives on a mounted
# volume at /data and is uploaded once, by hand. See deploy/upload-db.sh.

FROM node:24-slim

ENV NODE_ENV=production
# node:sqlite still prints an ExperimentalWarning on Node 24. Only that class of
# warning is silenced; everything else still reaches the logs.
# The heap ceiling is raised because V8 sets its default from the machine's
# RAM — 2,150 MB on the 4 GB machine — and the filter index alone retains about
# 1,040 MB at a million jobs (measured 2026-08-27). That fits, but the corpus
# grows every night; 3 GB leaves the ceiling above any size the machine could
# actually hold rather than below it. See docs/deploy.md, "Memory".
ENV NODE_OPTIONS="--disable-warning=ExperimentalWarning --max-old-space-size=3072"
WORKDIR /app

# ca-certificates: the Google sign-in token exchange makes an outbound HTTPS
# call, and a slim base image has no trust store of its own.
# gzip: the database arrives on the volume compressed and is unpacked in place.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates gzip \
 && rm -rf /var/lib/apt/lists/*

# Dependencies first, in their own layer: package.json changes rarely, so this
# install is cached and every later code deploy skips it.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY app/ ./app/

# The starter profiles ship in the image, but the *live* profile directory is on
# the volume: a profile saved through the UI has to outlive the next deploy. The
# entrypoint seeds the volume from this copy the first time it boots.
COPY profiles/ ./profiles-seed/

COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
