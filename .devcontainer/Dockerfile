FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

ARG USERNAME=vscode

# ── System dependencies ────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    zip \
    git \
    openssh-client \
    openssh-server \
    build-essential \
    protobuf-compiler \
    libprotobuf-dev \
    netcat-openbsd \
    jq \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 22 LTS (Vite/React dashboard toolchain) ───────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── act — local GitHub Actions runner ─────────────────────────────────────────
RUN curl -s https://raw.githubusercontent.com/nektos/act/master/install.sh \
    | bash -s -- -b /usr/local/bin

# ── ts-proto — protobuf TypeScript codegen plugin ─────────────────────────────
RUN npm install -g ts-proto

# ── Bun (installed as vscode user so ~/.bun is owned correctly) ───────────────
USER $USERNAME
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/${USERNAME}/.bun/bin:${PATH}"

# Smoke-test the install
RUN /home/${USERNAME}/.bun/bin/bun --version
