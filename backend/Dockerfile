# Multi-arch: the base image and ffmpeg both ship arm64 and amd64, and every
# npm dependency is pure JS, so no emulation is needed on either host.

# base
FROM node:20-bookworm-slim AS base

# ffmpeg for remuxing/transcoding, tini so ffmpeg children get reaped
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates \
        tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# deps
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install --include=dev --no-audit --no-fund

# builder
FROM deps AS builder
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# development
FROM base AS development
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "dev"]

# production
FROM base AS production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/dist ./dist

RUN mkdir -p /data/media /data/torrents /data/avatars \
 && chown -R node:node /data /app

USER node
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
