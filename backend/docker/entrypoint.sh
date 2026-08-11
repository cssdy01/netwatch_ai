#!/bin/bash
# entrypoint.sh
# Startup order: configure Postfix → start Postfix → verify → start Node.js
# Postfix failure is non-fatal — monitoring keeps running, only mail alerts fail.

# ── 1. Setup Postfix config ───────────────────────────────────────────────────
/postfix-setup.sh

# ── 2. Start Postfix ──────────────────────────────────────────────────────────
echo "[Postfix] Starting master process..."

# Kill any stale pid from a previous container run
rm -f /var/spool/postfix/pid/master.pid 2>/dev/null || true

/usr/sbin/postfix start 2>&1
sleep 3

# ── 3. Verify Postfix is actually running ─────────────────────────────────────
if /usr/sbin/postfix status > /dev/null 2>&1; then
    echo "[Postfix] Running OK — relay: ${POSTFIX_RELAY:-172.17.0.1:25}"
else
    echo "[Postfix] First start failed. Checking for errors..."
    /usr/sbin/postfix check 2>&1 || true

    # Common fix: stale pid or lock
    rm -f /var/spool/postfix/pid/master.pid 2>/dev/null || true

    echo "[Postfix] Retrying..."
    /usr/sbin/postfix start 2>&1 || true
    sleep 3

    if /usr/sbin/postfix status > /dev/null 2>&1; then
        echo "[Postfix] Running OK after retry."
    else
        echo "[Postfix] FAILED — mail alerts will not work."
        echo "[Postfix] Debug: docker exec -it netwatch-backend bash"
        echo "[Postfix]   then: /usr/sbin/postfix check"
        echo "[Postfix]   then: /usr/sbin/postfix start"
        echo "[Postfix] Continuing startup — monitoring runs without mail."
    fi
fi

# ── 4. Verify mail binary ─────────────────────────────────────────────────────
for bin in /usr/bin/bsd-mailx /usr/bin/mailx /usr/bin/mail; do
    if [ -x "$bin" ]; then
        echo "[NetWatch Mail] Binary: $bin"
        break
    fi
done

# ── 5. Start Node.js ──────────────────────────────────────────────────────────
echo "[NetWatch] Starting on port ${PORT:-3000}..."
exec node src/index.js
