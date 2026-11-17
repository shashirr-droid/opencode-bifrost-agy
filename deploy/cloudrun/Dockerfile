FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/*

# Place your statically compiled `bifrost-http` Linux x86_64 binary in this directory before building
COPY bifrost-http /usr/local/bin/bifrost-http
COPY config.template.json /app/config.template.json
COPY receipt_bridge.py /app/receipt_bridge.py
COPY entrypoint.sh /app/entrypoint.sh

RUN chmod 0755 /usr/local/bin/bifrost-http /app/entrypoint.sh /app/receipt_bridge.py

ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
