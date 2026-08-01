FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ENV NEXT_PUBLIC_API_URL=http://backend:4000
RUN npm run build

# Build-version stamp. Served as /build.txt by Next at runtime so the
# client-side VersionWatcher can detect a newer image and reload the
# page. Includes git short SHA when available so we can trace the
# commit that produced the bundle; falls back to a UTC timestamp for
# local builds where git metadata is absent.
ARG GIT_SHA=local
RUN printf '%s %s\n' "${GIT_SHA}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > /app/public/build.txt

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
