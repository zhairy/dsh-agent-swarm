FROM node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3=3.11.2-1+b1 \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
USER 1000:1000
WORKDIR /tmp
CMD ["node", "--version"]
