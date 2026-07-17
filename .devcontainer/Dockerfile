FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

ARG USERNAME=vscode
ARG BUN_VERSION=1.3.14

RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    git \
    jq \
    netcat-openbsd \
    openssh-client \
    openssh-server \
    unzip \
    zip \
    && rm -rf /var/lib/apt/lists/*

USER $USERNAME
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
ENV PATH="/home/${USERNAME}/.bun/bin:${PATH}"

RUN test "$(/home/${USERNAME}/.bun/bin/bun --version)" = "${BUN_VERSION}"
