FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node server.js admin-auth.js knowledge-store.js live-control-store.js ops-log-store.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node bundled-knowledge ./bundled-knowledge

RUN mkdir -p /data && chown node:node /data
COPY --chown=node:node content.json /data/content.json

ENV HOST=0.0.0.0 \
    PORT=8080 \
    CONTENT_FILE=/data/content.json \
    MODEL_CONFIG_FILE=/data/model-config.json \
    KNOWLEDGE_FILE=/data/knowledge.json \
    KNOWLEDGE_FILES_DIR=/data/knowledge-files \
    ADMIN_AUTH_FILE=/data/admin-auth.json \
    LIVE_CONTROL_FILE=/data/host-scripts.json \
    OPS_LOG_FILE=/data/operations.jsonl \
    CONTENT_POLL_INTERVAL_MS=2000

EXPOSE 8080

VOLUME ["/data"]

USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ready >/dev/null || exit 1

CMD ["node", "server.js"]
