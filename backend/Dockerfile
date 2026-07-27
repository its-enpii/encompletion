# Debian slim — needed for ONNX runtime used by the local embedder
# (@xenova/transformers). Alpine's musl libc can't load the ONNX shared
# library, so we drop to glibc. ~150MB larger image in exchange for
# a self-contained embedding pipeline (no API key for vectorization).
FROM node:22-bookworm-slim

# Claude Code CLI (legacy engine) + poppler for PDF OCR + gosu for
# root→app drop in the entrypoint. g++/python3/make for native modules.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl bash python3 make g++ poppler-utils ca-certificates gosu \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code@latest \
    && groupadd -r app && useradd -r -g app -u 10001 -d /app -s /usr/sbin/nologin app

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN npm rebuild better-sqlite3 \
 && mkdir -p /app/storage/attachments /app/storage/models /app/storage/workdirs /app/data /app/skills \
 && chown -R app:app /app \
 && chmod +x /app/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=4000 \
    TRANSFORMERS_CACHE=/app/storage/models \
    ENLLM_SKILLS_DIR=/app/skills \
    HOME=/app

EXPOSE 4000

# Entrypoint starts as root only long enough to chown volumes, then
# re-execs as uid 10001. CMD runs the node server under that user.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
