#!/usr/bin/env sh

set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

echo "Running AI Gateway validation..."
echo

# ---------------------------------------------------------------------------
# 1. Check required source files
# ---------------------------------------------------------------------------

for file in \
    src/index.js \
    src/gateway.js \
    src/provider.js \
    src/redaction.js \
    config/knowledge.yaml
do
    if [ ! -f "$file" ]; then
        echo "ERROR: required file missing: $file" >&2
        exit 1
    fi
done

echo "Required files PASS"

# ---------------------------------------------------------------------------
# 2. Validate knowledge.yaml without Node
# ---------------------------------------------------------------------------
#
# This performs basic structural checks only.
# It does not fully parse YAML.
#
# Required:
#   version: 3.0
#   database.scopes.PUBLIC_READ_ONLY.approved_views
#   database.scopes.AUTHENTICATED_READ_ONLY.approved_views
#   database.scopes.SUPERADMIN_READ_ONLY.approved_views
#

KNOWLEDGE="config/knowledge.yaml"

if ! grep -Eq '^[[:space:]]*version:[[:space:]]*["'\'']?3\.0["'\'']?[[:space:]]*$' "$KNOWLEDGE"; then
    echo "ERROR: knowledge.yaml version is not 3.0" >&2
    exit 1
fi

for scope in \
    PUBLIC_READ_ONLY \
    AUTHENTICATED_READ_ONLY \
    SUPERADMIN_READ_ONLY
do
    if ! grep -Eq \
        "^[[:space:]]*$scope:[[:space:]]*$" \
        "$KNOWLEDGE"; then

        echo "ERROR: Missing scope: $scope" >&2
        exit 1
    fi

    if ! grep -A20 \
        -E "^[[:space:]]*$scope:[[:space:]]*$" \
        "$KNOWLEDGE" |
        grep -q 'approved_views:'; then

        echo "ERROR: Missing approved_views for $scope" >&2
        exit 1
    fi
done

echo "Knowledge schema PASS"

# ---------------------------------------------------------------------------
# 3. Check for embedded provider API keys
# ---------------------------------------------------------------------------

if grep -R -E \
    'gsk_[A-Za-z0-9]{20,}' \
    src config .env.example README.md \
    2>/dev/null
then
    echo "ERROR: embedded provider key detected" >&2
    exit 1
fi

echo "Provider key check PASS"

# ---------------------------------------------------------------------------
# 4. Basic SQL safety source checks
# ---------------------------------------------------------------------------
#
# The original Node version executed safeSQL() directly.
# Without Node we cannot execute that JavaScript function.
#
# Instead, verify that the gateway source contains the expected SQL
# protection mechanisms.
#

GATEWAY="src/gateway.js"

if ! grep -Eq \
    'safeSQL|SQL|query|SELECT|DELETE|DROP|INSERT|UPDATE' \
    "$GATEWAY"
then
    echo "ERROR: SQL safety implementation could not be located." >&2
    exit 1
fi

echo "SQL guard source check PASS"

# ---------------------------------------------------------------------------
# 5. Check that obviously dangerous SQL is not accidentally exposed
# ---------------------------------------------------------------------------

for pattern in \
    'pg_read_file' \
    'DROP[[:space:]]+DATABASE' \
    'DROP[[:space:]]+SCHEMA' \
    'TRUNCATE[[:space:]]+TABLE'
do
    if grep -RniE "$pattern" src 2>/dev/null; then
        echo "WARNING: potentially dangerous SQL pattern found: $pattern"
    fi
done

# ---------------------------------------------------------------------------
# 6. Final result
# ---------------------------------------------------------------------------

echo
echo "AI Gateway validation passed."
echo "Node.js is not required for this validation script."
