FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/root/.risc0/bin:/root/.cargo/bin:${PATH}"
ENV PORT=10000
ENV PAYGUARD_REAL_PROVER_CMD=scripts/prove-risc0-groth16.sh
ENV PAYGUARD_VERIFIER_MODE=risc0-groth16-onchain
ENV PAYGUARD_SKIP_RZUP_INSTALL=true

RUN apt-get update && apt-get install -y \
    bash \
    build-essential \
    ca-certificates \
    clang \
    cmake \
    curl \
    git \
    libssl-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get update \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

RUN curl -L https://risczero.com/install | bash

RUN --mount=type=secret,id=GITHUB_TOKEN \
    export GITHUB_TOKEN=$(cat /run/secrets/GITHUB_TOKEN) && \
    rzup install && \
    rzup install risc0-groth16


WORKDIR /app

COPY package.json package-lock.json ./
COPY apps ./apps
COPY services ./services
COPY packages ./packages
COPY zk ./zk
COPY scripts ./scripts
COPY tsconfig.base.json ./

RUN npm install

RUN npm run build --workspace @payguard/protocol
RUN npm run build --workspace @payguard/api
RUN cd zk/risc0 && cargo build --release -p payguard-risc0-prover

EXPOSE 10000

CMD ["npm", "run", "start", "--workspace", "@payguard/api"]
