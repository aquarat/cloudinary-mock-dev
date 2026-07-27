FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src

ENV PORT=3000
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "src/index.ts"]
