FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Place your statically compiled unmodified `bifrost-http` Linux x86_64 binary in this directory before building
COPY bifrost-http /usr/local/bin/bifrost-http
COPY config.template.json /app/config.template.json
COPY entrypoint.sh /app/entrypoint.sh

RUN chmod 0755 /usr/local/bin/bifrost-http /app/entrypoint.sh

ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
