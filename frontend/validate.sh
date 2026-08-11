#!/usr/bin/env sh

set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

echo "Running Netwatch Frontend validation..."
echo

# ---------------------------------------------------------------------------
# 1. Required files
# ---------------------------------------------------------------------------

for file in \
    public/config.js \
    public/js/api.js \
    public/js/ai-assistant.js \
    public/index.html \
    public/admin/login.html \
    public/admin/dashboard.html \
    docker/10-render-nginx.sh \
    deploy.sh \
    nginx/nginx.conf.template
do
    if [ ! -f "$file" ]; then
        echo "ERROR: required file missing: $file" >&2
        exit 1
    fi
done

echo "Required files PASS"

# ---------------------------------------------------------------------------
# 2. Shell syntax validation
# ---------------------------------------------------------------------------

if ! sh -n docker/10-render-nginx.sh; then
    echo "ERROR: docker/10-render-nginx.sh has shell syntax errors." >&2
    exit 1
fi

echo "Nginx render script syntax PASS"

if ! sh -n deploy.sh; then
    echo "ERROR: deploy.sh has shell syntax errors." >&2
    exit 1
fi

echo "Deploy script syntax PASS"

# ---------------------------------------------------------------------------
# 3. Basic HTML validation
# ---------------------------------------------------------------------------
#
# This is intentionally lightweight and does not require Node, Python,
# xmllint, or another HTML parser.
#

for file in \
    public/index.html \
    public/admin/login.html \
    public/admin/dashboard.html
do
    if ! grep -qi '<html' "$file"; then
        echo "ERROR: missing <html> tag: $file" >&2
        exit 1
    fi

    if ! grep -qi '</html>' "$file"; then
        echo "ERROR: missing </html> tag: $file" >&2
        exit 1
    fi
done

echo "HTML shell validation PASS"

# ---------------------------------------------------------------------------
# 4. Required AI asset references
# ---------------------------------------------------------------------------

for file in \
    public/index.html \
    public/admin/dashboard.html
do
    for asset in \
        '/js/api.js' \
        '/js/ai-assistant.js' \
        '/ai-assistant.css'
    do
        if ! grep -Fq "$asset" "$file"; then
            echo "ERROR: $file missing $asset" >&2
            exit 1
        fi
    done
done

echo "HTML and AI asset references PASS"

# ---------------------------------------------------------------------------
# 5. API/session functionality references
# ---------------------------------------------------------------------------

if ! grep -Fq 'aiResetSession' public/js/api.js; then
    echo "ERROR: aiResetSession missing from public/js/api.js" >&2
    exit 1
fi

if ! grep -Fq 'aiCloseSession' public/js/api.js; then
    echo "ERROR: aiCloseSession missing from public/js/api.js" >&2
    exit 1
fi

echo "AI session API references PASS"

# ---------------------------------------------------------------------------
# 6. AI assistant error handling
# ---------------------------------------------------------------------------

for pattern in \
    'PROVIDER_RATE_LIMIT' \
    'BACKEND_SQL_FLOW_INCOMPLETE' \
    'INVALID_STRUCTURED_OUTPUT'
do
    if ! grep -Fq "$pattern" public/js/ai-assistant.js; then
        echo "ERROR: missing AI error state: $pattern" >&2
        exit 1
    fi
done

echo "AI error handling references PASS"

# ---------------------------------------------------------------------------
# 7. AI assistant response validation
# ---------------------------------------------------------------------------

if ! grep -Fq \
    'Number.isFinite(Number(m.meta.rowCount))' \
    public/js/ai-assistant.js
then
    echo "ERROR: rowCount validation missing." >&2
    exit 1
fi

echo "AI response validation PASS"

# ---------------------------------------------------------------------------
# 8. AI chat controls
# ---------------------------------------------------------------------------

for pattern in \
    'nwAiCloseChat' \
    'nwAiHide' \
    'data-followup'
do
    if ! grep -Fq "$pattern" public/js/ai-assistant.js; then
        echo "ERROR: missing AI UI control/reference: $pattern" >&2
        exit 1
    fi
done

echo "AI chat controls PASS"

# ---------------------------------------------------------------------------
# 9. AI state/filter handling
# ---------------------------------------------------------------------------

if ! grep -Fq 'state.filters' public/js/ai-assistant.js; then
    echo "ERROR: state.filters reference missing." >&2
    exit 1
fi

echo "AI state/filter handling PASS"

# ---------------------------------------------------------------------------
# 10. Frontend backend configuration
# ---------------------------------------------------------------------------

if ! grep -Fq "backendUrl: ''" public/config.js; then
    echo "ERROR: expected empty backendUrl configuration missing." >&2
    exit 1
fi

echo "Frontend backend configuration PASS"

# ---------------------------------------------------------------------------
# 11. Nginx backend proxy
# ---------------------------------------------------------------------------

if ! grep -Fq \
    'proxy_pass ${BACKEND_UPSTREAM}' \
    nginx/nginx.conf.template
then
    echo "ERROR: expected BACKEND_UPSTREAM proxy configuration missing." >&2
    exit 1
fi

echo "Nginx backend proxy configuration PASS"

# ---------------------------------------------------------------------------
# 12. Check for old localhost backend endpoint
# ---------------------------------------------------------------------------
#
# Search for the actual URL, not Markdown link syntax.
#

if grep -RniF \
    'http://localhost:3000' \
    public
then
    echo "ERROR: old browser backend endpoint found." >&2
    exit 1
fi

echo "Old localhost backend endpoint check PASS"

# ---------------------------------------------------------------------------
# 13. Check for embedded secrets
# ---------------------------------------------------------------------------

if grep -RniE \
    'gsk_[A-Za-z0-9]{20,}|NETWATCH_AI_SERVICE_TOKEN=.{20,}|JWT_SECRET=.{20,}|DB_PASSWORD=.{8,}' \
    public \
    README.md \
    compose.yaml \
    Dockerfile \
    2>/dev/null
then
    echo "ERROR: embedded secret found." >&2
    exit 1
fi

echo "Embedded secret scan PASS"

# ---------------------------------------------------------------------------
# 14. Final result
# ---------------------------------------------------------------------------

echo
echo "============================================================"
echo " Netwatch Frontend validation passed."
echo " Node.js and npm are NOT required by this script."
echo "============================================================"
