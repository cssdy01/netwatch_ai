#!/bin/bash
# postfix-setup.sh
# Writes Postfix config and rebuilds aliases.
# Called by entrypoint.sh at container startup.
# NO set -e — every step must complete even if one fails.

RELAY="${POSTFIX_RELAY:-172.17.0.1:25}"
RELAY_HOST="${RELAY%%:*}"
RELAY_PORT="${RELAY##*:}"

echo "[Postfix] Writing config → relay: [${RELAY_HOST}]:${RELAY_PORT}"

# Write main.cf — minimal satellite config, relay everything to host
cat > /etc/postfix/main.cf << MAINCF
compatibility_level = 2
myhostname = netwatch-container
myorigin = netwatch-container
inet_interfaces = loopback-only
inet_protocols = ipv4
relayhost = [${RELAY_HOST}]:${RELAY_PORT}
mydestination = 
mynetworks = 127.0.0.0/8
smtp_tls_security_level = may
maillog_file = /dev/stdout
MAINCF

echo "[Postfix] main.cf written."

# master.cf — keep the default but ensure it exists
if [ ! -f /etc/postfix/master.cf ]; then
    echo "[Postfix] master.cf missing — copying from default..."
    cp /usr/share/postfix/master.cf.dist /etc/postfix/master.cf 2>/dev/null || \
    cat > /etc/postfix/master.cf << 'MASTERCF'
smtp      inet  n       -       y       -       -       smtpd
pickup    unix  n       -       y       60      1       pickup
cleanup   unix  n       -       y       -       0       cleanup
qmgr      unix  n       -       n       300     1       qmgr
tlsmgr    unix  -       -       y       1000?   1       tlsmgr
rewrite   unix  -       -       y       -       -       trivial-rewrite
bounce    unix  -       -       y       -       0       bounce
defer     unix  -       -       y       -       0       bounce
trace     unix  -       -       y       -       0       bounce
verify    unix  -       -       y       -       1       verify
flush     unix  n       -       y       1000?   0       flush
proxymap  unix  -       -       n       -       -       proxymap
proxywrite unix -       -       n       -       1       proxymap
smtp      unix  -       -       y       -       -       smtp
relay     unix  -       -       y       -       -       smtp
showq     unix  n       -       y       -       -       showq
error     unix  -       -       y       -       -       error
retry     unix  -       -       y       -       -       error
discard   unix  -       -       y       -       -       discard
local     unix  -       n       n       -       -       local
virtual   unix  -       n       n       -       -       virtual
lmtp      unix  -       -       y       -       -       lmtp
anvil     unix  -       -       y       -       1       anvil
scache    unix  -       -       y       -       1       scache
MASTERCF
fi

# Ensure aliases file exists and rebuild db
touch /etc/aliases
newaliases 2>/dev/null && echo "[Postfix] aliases rebuilt." || echo "[Postfix] newaliases warning (non-fatal)."

# Ensure all spool dirs exist
for dir in incoming active deferred bounce defer flush hold corrupt trace maildrop pid private public; do
    mkdir -p "/var/spool/postfix/${dir}"
done

# Apply correct standard Postfix ownership & permissions (Fixes the duplicate pickup daemon loop)
chown -R postfix:postfix /var/spool/postfix 2>/dev/null || true
chown root:root /var/spool/postfix 2>/dev/null || true
chown postfix:postdrop /var/spool/postfix/maildrop 2>/dev/null || true
chown postfix:postdrop /var/spool/postfix/public 2>/dev/null || true

chmod 1733 /var/spool/postfix/maildrop 2>/dev/null || true
chmod 0710 /var/spool/postfix/public 2>/dev/null || true

# Set the necessary setgid permissions on command-line mailing binaries
chmod g+s /usr/sbin/postdrop /usr/sbin/postqueue 2>/dev/null || true

mkdir -p /var/lib/postfix
chown postfix:postfix /var/lib/postfix 2>/dev/null || true

echo "[Postfix] Spool directories ready."

# Validate config
/usr/sbin/postfix check 2>&1 && echo "[Postfix] Config check passed." || echo "[Postfix] Config check had warnings (may still work)."