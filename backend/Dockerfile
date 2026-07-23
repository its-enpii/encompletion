# Debian slim — needed for ONNX runtime used by the local embedder
# (@xenova/transformers). Alpine's musl libc can't load the ONNX shared
# library, so we drop to glibc. ~150MB larger image in exchange for
# a self-contained embedding pipeline (no API key for vectorization).
FROM node:22-bookworm-slim

# Install Claude Code CLI globally + poppler-utils for PDF OCR
# (pdftoppm renders pages to PNG before tesseract reads them).
# g++ + python3 + make are present so npm rebuilds (e.g. better-sqlite3)
# work on the bookworm glibc ABI.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl bash python3 make g++ poppler-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code@latest

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# better-sqlite3 native bindings must be built against the container's
# node ABI. Rebuild to be safe (already installed once; this is fast and
# avoids host/container mismatch).
RUN npm rebuild better-sqlite3

RUN mkdir -p /app/storage/attachments /app/storage/models /app/data

ENV NODE_ENV=production \
    PORT=4000 \
    TRANSFORMERS_CACHE=/app/storage/models

EXPOSE 4000

CMD ["node", "src/server.js"]
