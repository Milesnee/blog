# Dockerfile for milestone-1 worker (alternative to bwrap)
FROM node:22-slim

WORKDIR /opt/openclaw-worker

# Install only production deps; copy lockfile if present for reproducibility
COPY package.json ./
COPY package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY worker ./worker

# Drop to non-root for sandbox parity with bwrap
RUN useradd -u 10001 -m -s /usr/sbin/nologin worker && \
    mkdir -p /home/user && chown worker:worker /home/user
USER worker

ENTRYPOINT ["node", "/opt/openclaw-worker/worker/worker.mjs"]
