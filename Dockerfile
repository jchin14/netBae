# netBae in a container. Multi-arch: linux/amd64, linux/arm64, linux/arm/v7.
#   docker compose up -d        (see docker-compose.yml: host networking is strongly recommended)
FROM python:3.12-slim-bookworm

ARG TARGETARCH
ARG TARGETVARIANT
ARG SPEEDTEST_VERSION=1.2.0
ARG CHARTJS_URL=https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js
ARG ADAPTER_URL=https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js

# ping, traceroute, tzdata (schedules follow local time) and the official Ookla Speedtest CLI
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends iputils-ping traceroute iproute2 ca-certificates curl tzdata; \
    case "${TARGETARCH}${TARGETVARIANT}" in \
      amd64) st=x86_64 ;; arm64) st=aarch64 ;; armv7) st=armhf ;; armv6) st=armel ;; 386) st=i386 ;; \
      *) echo "unsupported architecture ${TARGETARCH}${TARGETVARIANT}"; exit 1 ;; \
    esac; \
    curl -fsSL "https://install.speedtest.net/app/cli/ookla-speedtest-${SPEEDTEST_VERSION}-linux-${st}.tgz" \
      | tar -xz -C /usr/local/bin speedtest; \
    rm -rf /var/lib/apt/lists/*

COPY app/ /opt/netbae/
COPY config.toml /opt/netbae/config.default.toml
COPY docker/entrypoint.sh /usr/local/bin/netbae-entrypoint
RUN set -eux; \
    mkdir -p /opt/netbae/static/vendor; \
    curl -fsSL "$CHARTJS_URL" -o /opt/netbae/static/vendor/chart.umd.min.js; \
    curl -fsSL "$ADAPTER_URL" -o /opt/netbae/static/vendor/chartjs-adapter-date-fns.bundle.min.js; \
    chmod +x /usr/local/bin/netbae-entrypoint; \
    python3 -m py_compile /opt/netbae/netbae.py

ENV NETBAE_DOCKER=1 \
    NETBAE_CONFIG=/data/config.toml \
    PYTHONUNBUFFERED=1 \
    TZ=UTC
VOLUME ["/data"]
EXPOSE 80
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD python3 -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/config' % os.environ.get('NETBAE_PORT', '80'), timeout=4)" || exit 1
ENTRYPOINT ["netbae-entrypoint"]
