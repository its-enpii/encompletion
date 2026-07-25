# Custom nginx image that runs the standard daemon in foreground plus
# a sidecar healthcheck script that polls the backend and reloads
# nginx whenever the upstream changes. Without this, every container
# recreate leaves nginx holding stale DNS for the upstream and the
# frontend sees HTTP 502 until someone manually runs `nginx -s
# reload`.

FROM nginx:alpine

# Mirror the upstream alpine image's shell + wget presence — both
# are already installed in nginx:alpine, but we list them so a
# future base swap can't accidentally drop either.
RUN apk add --no-cache bash wget

# Drop the watchdog script. nginx -s reload is the only side-effect
# we perform so the runner container doesn't need anything else.
COPY healthcheck-reload.sh /healthcheck-reload.sh
RUN chmod +x /healthcheck-reload.sh

# Background the watchdog and foreground nginx. We exec the entry-
# point so signals (SIGTERM from docker stop) hit nginx directly,
# not the parent shell.
CMD ["/bin/sh", "-c", "/healthcheck-reload.sh & exec nginx -g 'daemon off;'"]
