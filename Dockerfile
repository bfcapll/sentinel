# Same artifact as the Windows service: `node dist/cli.js run --config <config dir>` with the
# working directory holding .env, ./data and ./backups. Keep in sync with deploy/windows/*.ps1.
FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 ships prebuilt binaries; the toolchain is the fallback when none matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /sentinel
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# config/ is mounted, never baked in (it holds wallet addresses); secrets come from env_file/.env.
VOLUME ["/sentinel/data", "/sentinel/backups"]
USER node
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
  CMD ["node", "dist/cli.js", "healthcheck", "--config", "/sentinel/config", "--max-age", "300"]
CMD ["node", "dist/cli.js", "run", "--config", "/sentinel/config"]
