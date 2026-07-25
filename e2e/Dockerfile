# e2e/Dockerfile — Playwright runner.
#
# The image ships Chromium + node + system libs. We install the npm
# package OUTSIDE /work because the host volume mount in docker-compose
# replaces /work entirely (including node_modules). Putting the deps
# in /opt/playwright keeps them stable across host-mount refreshes.

FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /opt/playwright

# Install only the deps we need.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# Wrapper script — runs the installed playwright binary regardless of
# how the entrypoint is invoked. Avoids "command not found" when the
# host shell translates the path argument.
RUN printf '#!/bin/sh\ncd /work\nexec env NODE_PATH=/opt/playwright/node_modules /opt/playwright/node_modules/.bin/playwright "$@"\n' \
    > /usr/local/bin/run-tests \
 && chmod +x /usr/local/bin/run-tests

# Sources are mounted at /work by docker-compose.
WORKDIR /work

ENTRYPOINT ["/usr/local/bin/run-tests"]
CMD ["--help"]
