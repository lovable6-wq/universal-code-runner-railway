FROM node:22-bookworm
ARG INSTALL_RUST=0
ARG INSTALL_DOTNET=0
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv golang default-jdk-headless maven \
    php-cli composer ruby-full lua5.4 perl gcc g++ make cmake git unzip zip \
    binutils xxd util-linux procps curl ca-certificates sqlite3 \
    && rm -rf /var/lib/apt/lists/*
RUN if [ "$INSTALL_RUST" = "1" ]; then curl -sSf https://sh.rustup.rs | RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo sh -s -- -y --profile minimal && ln -s /opt/cargo/bin/* /usr/local/bin/; fi
RUN if [ "$INSTALL_DOTNET" = "1" ]; then curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0 --install-dir /opt/dotnet && ln -s /opt/dotnet/dotnet /usr/local/bin/dotnet; fi
RUN useradd -m -u 1001 -s /bin/bash runner
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
CMD ["node","server.js"]
