FROM node:24-alpine

# Install Claude Code CLI globally
RUN apk add --no-cache git curl bash python3 make g++ \
    && npm install -g @anthropic-ai/claude-code@latest

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# better-sqlite3 native bindings must be built against the container's node ABI.
# Rebuild to be safe (already installed once; this is fast and avoids host/container mismatch).
RUN npm rebuild better-sqlite3

RUN mkdir -p /app/storage/attachments /app/data

ENV NODE_ENV=production
ENV PORT=4000

EXPOSE 4000

CMD ["node", "src/server.js"]
