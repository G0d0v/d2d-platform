FROM node:24-bookworm-slim
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates tini python3 && rm -rf /var/lib/apt/lists/*
RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}"; case "$arch" in amd64) hash=51a8cdf4a1252e79f4b3855d7a7891af6c6635105420768c460e2f0690385d6f;; arm64) hash=1e99403746406e8199efc903ddd1940d5728a60e50241f7aa6c9f2b907bd8ec9;; *) exit 1;; esac; curl --fail --location --retry 3 "https://codeberg.org/forgejo/forgejo/releases/download/v17.0.1/forgejo-17.0.1-linux-$arch" -o /usr/local/bin/forgejo && echo "$hash  /usr/local/bin/forgejo" | sha256sum --check && chmod 755 /usr/local/bin/forgejo
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY server ./server
COPY web ./web
COPY scripts ./scripts
COPY docs ./docs
COPY cli ./cli
COPY tsconfig.json vite.config.ts ./
RUN npm run build && mkdir /data && chown node:node /data && chmod +x scripts/container-entrypoint.sh
ENV NODE_ENV=production HOST=0.0.0.0 ALLOW_CONTAINER_BIND=1 PORT=19090 DATA_DIR=/data/app
USER node
VOLUME /data
EXPOSE 19090
ENTRYPOINT ["tini","--","/app/scripts/container-entrypoint.sh"]
