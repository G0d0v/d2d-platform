FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY server ./server
COPY web ./web
COPY scripts ./scripts
COPY docs ./docs
COPY cli ./cli
COPY tsconfig.json vite.config.ts ./
RUN npm run build
ENV NODE_ENV=production HOST=0.0.0.0 ALLOW_CONTAINER_BIND=1 PORT=19090 DATA_DIR=/data
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 19090
CMD ["node","--import","tsx","server/index.ts"]
