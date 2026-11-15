# Clean-room image for every test layer: format, lint, typecheck, unit tests
# and the e2e suites. The Playwright base image brings Node and Chromium at
# the same version as @playwright/test in e2e/package.json.
#
# Run it with `bun run test:e2e:docker`, which mounts ./.e2e for the report
# and caches Cargo between runs.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

ARG RUST_VERSION=1.98.0
ARG BUN_VERSION=1.4.0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential pkg-config unzip curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:/root/.bun/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
    | sh -s -- -y --no-modify-path --profile minimal \
      --default-toolchain "${RUST_VERSION}" --component rustfmt --component clippy \
    && curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"

LABEL dopbase.test="true"
WORKDIR /workspace

# A workspace install needs every member's package.json first.
COPY package.json bun.lock ./
COPY ui/package.json ./ui/
COPY docs/package.json ./docs/
COPY e2e/package.json ./e2e/
RUN bun install --frozen-lockfile

COPY . .

CMD ["bun", "run", "test", "--", "--agent"]
