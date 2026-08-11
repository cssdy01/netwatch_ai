# ┌── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ┌── Runtime stage ────────────────────────────────────────────────────────────
FROM node:20-slim

# bsd-mailx   — mail binary (provides /usr/bin/bsd-mailx and /usr/bin/mail symlink)
# postfix     — local MTA, relays to host on port 25
# iputils-ping — system ping for ICMP agent
# procps      — ps (debug)
RUN apt-get update && apt-get install -y --no-install-recommends \
      bsd-mailx \
      postfix \
      iputils-ping \
      procps \
    && rm -rf /var/lib/apt/lists/*

# Pre-create all Postfix spool directories with correct standard permissions.
# This ensures the pickup daemon can safely purge the maildrop queue files after transmission.
RUN mkdir -p \
      /var/spool/postfix/incoming \
      /var/spool/postfix/active \
      /var/spool/postfix/deferred \
      /var/spool/postfix/bounce \
      /var/spool/postfix/defer \
      /var/spool/postfix/flush \
      /var/spool/postfix/hold \
      /var/spool/postfix/corrupt \
      /var/spool/postfix/trace \
      /var/spool/postfix/maildrop \
      /var/spool/postfix/pid \
      /var/spool/postfix/private \
      /var/spool/postfix/public \
      /var/lib/postfix \
    && chown -R postfix:postfix /var/spool/postfix \
    && chown root:root /var/spool/postfix \
    && chown postfix:postdrop /var/spool/postfix/maildrop \
    && chown postfix:postdrop /var/spool/postfix/public \
    && chmod 1733 /var/spool/postfix/maildrop \
    && touch /etc/aliases \
    && newaliases

COPY docker/postfix-setup.sh /postfix-setup.sh
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /postfix-setup.sh /entrypoint.sh

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
RUN mkdir -p /app/data

EXPOSE 3000

ENV PORT=3000 \
    TZ=Asia/Kolkata \
    DATA_DIR=/app/data \
    SESSION_HOURS=8 \
    DEFAULT_N_THRESHOLD=2 \
    PRUNE_DAYS=60 \
    POSTFIX_RELAY="172.17.0.1:25"

CMD ["/entrypoint.sh"]