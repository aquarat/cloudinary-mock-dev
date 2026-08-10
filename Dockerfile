FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Bundles the optional React admin UI (web/ -> web/dist) with Bun's bundler.
# Kept in its own stage so the sources and build-time files never reach the
# runtime image — only the emitted app.js/app.css do.
FROM oven/bun:1 AS webbuild
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY web ./web
RUN bun run build:web

FROM oven/bun:1
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src
# The admin route serves these when ADMIN_USERNAME/ADMIN_PASSWORD are set; the
# files are harmless (and unreachable) when the admin UI is disabled.
COPY --from=webbuild /app/web/dist ./web/dist

ENV PORT=3000
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "src/index.ts"]
