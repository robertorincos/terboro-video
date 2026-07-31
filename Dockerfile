# syntax=docker/dockerfile:1

FROM node:24-alpine AS base

# ---- dependencies -----------------------------------------------------------
FROM base AS deps
WORKDIR /app
# @next/swc's musl binary needs libc6-compat's shims on Alpine. youtube-dl-exec's
# preinstall check requires python3 on PATH even though it only downloads (not
# runs) the yt-dlp binary at this stage.
RUN apk add --no-cache libc6-compat python3
COPY package.json package-lock.json ./
# youtube-dl-exec's postinstall script downloads the yt-dlp binary here, so this
# step needs network access.
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

# yt-dlp (bundled by youtube-dl-exec) is a Python zipapp and needs python3 on
# PATH; ffmpeg merges the separate video/audio streams into a single .mp4.
RUN apk add --no-cache ffmpeg python3

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
