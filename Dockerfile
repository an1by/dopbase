FROM oven/bun:1 AS admin-ui

WORKDIR /workspace

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY index.html vite.config.ts tsconfig*.json eslint.config.js ./
COPY config ./config
COPY public ./public
COPY src ./src
RUN bun run build:ui

FROM rust:1.98-bookworm AS builder

WORKDIR /workspace

COPY app/Cargo.toml app/Cargo.lock app/rustfmt.toml ./app/
COPY app/src ./app/src
COPY app/migrations ./app/migrations
COPY --from=admin-ui /workspace/dist ./dist

WORKDIR /workspace/app
RUN cargo build --release --locked

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /workspace/app/target/release/dopbase /usr/local/bin/dopbase
RUN chmod 755 /usr/local/bin/dopbase

WORKDIR /data

ENTRYPOINT ["/usr/local/bin/dopbase"]
CMD ["server", "start", "--config", "/etc/dopbase/server.toml"]
