# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
# yt-dlp_musllinux is the native PyInstaller build of yt-dlp for musl (Alpine) —
# it bundles its own Python, so no python3 runtime dependency. Set here (not just
# in `deps`) so the runner stage also resolves youtube-dl-exec's binary path to
# the file that was actually downloaded.
ENV YOUTUBE_DL_FILENAME=yt-dlp_musllinux

# ---- dependencies -----------------------------------------------------------
FROM base AS deps
WORKDIR /app
# @next/swc's musl binary needs libc6-compat's shims on Alpine.
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
# youtube-dl-exec's postinstall script downloads the yt-dlp binary here, so this
# step needs network access. Skip the preinstall python3 interpreter check since
# the native binary doesn't need one.
ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=1
RUN npm ci

# ---- build --------------------------------------------------------------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runtime ------------------------------------------------------------
FROM base AS runner
WORKDIR /app

# yt-dlp (bundled by youtube-dl-exec) is the native yt-dlp_musllinux binary and
# needs no python3 runtime; ffmpeg merges the separate video/audio streams into
# a single .mp4.
RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Next's output tracing only follows static require()/import calls, but
# youtube-dl-exec resolves its yt-dlp binary path dynamically at runtime, so the
# tracer can miss bin/yt-dlp. Copy the whole package over the traced output to
# guarantee it's present, regardless of what tracing picked up.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/youtube-dl-exec ./node_modules/youtube-dl-exec

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
