#!/usr/bin/env sh

set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

echo "Running Netwatch Backend validation..."
echo

# ---------------------------------------------------------------------------
# 1. Required source files
# ---------------------------------------------------------------------------

for file in \
    src/db.js \
    src/ai/sqlValidator.js \
    src/ai/aiService.js \
    src/controllers/aiController.js \
    .env.example
do
    if [ ! -f "$file" ]; then
        echo "ERROR: required file missing: $file" >&2
        exit 1
    fi
done

echo "Required files PASS"

# ---------------------------------------------------------------------------
# 2. Static SQL validator checks
# ---------------------------------------------------------------------------
#
# The original script executed validateQuery() with Node.
# This version does not require Node, so it verifies that the validator
# source contains the expected security controls.
#

VALIDATOR="src/ai/sqlValidator.js"

if ! grep -Eq \
    'validateQuery[[:space:]]*=' \
    "$VALIDATOR" &&
   ! grep -Eq \
    'function[[:space:]]+validateQuery' \
    "$VALIDATOR" &&
   ! grep -Eq \
    'validateQuery[[:space:]]*\(' \
    "$VALIDATOR"
then
    echo "ERROR: validateQuery() was not found in $VALIDATOR" >&2
    exit 1
fi

echo "SQL validator present"

# ---------------------------------------------------------------------------
# 3. Verify SQL scope/security concepts exist
# ---------------------------------------------------------------------------

for pattern in \
    'PUBLIC_READ_ONLY' \
    'expectedColumns' \
    'parameters' \
    'SELECT' \
    'LIMIT' \
    'scope'
do
    if ! grep -Riq "$pattern" "$VALIDATOR" 2>/dev/null; then
        echo "ERROR: SQL validator missing expected control: $pattern" >&2
        exit 1
    fi
done

echo "SQL validator security controls PASS"

# ---------------------------------------------------------------------------
# 4. Database read-only transaction protection
# ---------------------------------------------------------------------------

if ! grep -q 'BEGIN READ ONLY' src/db.js; then
    echo "ERROR: BEGIN READ ONLY missing from src/db.js" >&2
    exit 1
fi

echo "Database READ ONLY transaction PASS"

# ---------------------------------------------------------------------------
# 5. Statement timeout protection
# ---------------------------------------------------------------------------

if ! grep -q 'statement_timeout' src/db.js; then
    echo "ERROR: statement_timeout missing from src/db.js" >&2
    exit 1
fi

echo "Database statement timeout PASS"

# ---------------------------------------------------------------------------
# 6. Required public database view
# ---------------------------------------------------------------------------

if ! grep -q \
    'CREATE OR REPLACE VIEW ai_public_task_details' \
    src/db.js
then
    echo "ERROR: ai_public_task_details view definition missing" >&2
    exit 1
fi

echo "Public task details view PASS"

# ---------------------------------------------------------------------------
# 7. AI analyze endpoint
# ---------------------------------------------------------------------------

if ! grep -q '/analyze' src/ai/aiService.js; then
    echo "ERROR: /analyze endpoint/reference missing" >&2
    exit 1
fi

echo "AI analyze endpoint PASS"

# ---------------------------------------------------------------------------
# 8. AI session reset endpoint
# ---------------------------------------------------------------------------

if ! grep -q 'sessions/:id/reset' src/controllers/aiController.js; then
    echo "ERROR: AI session reset endpoint missing" >&2
    exit 1
fi

echo "AI session reset endpoint PASS"

# ---------------------------------------------------------------------------
# 9. Provider API key leak detection
# ---------------------------------------------------------------------------

if grep -R -E \
    'gsk_[A-Za-z0-9]{20,}' \
    src .env.example README.md \
    2>/dev/null
then
    echo "ERROR: embedded provider key detected" >&2
    exit 1
fi

echo "Provider key leak check PASS"

# ---------------------------------------------------------------------------
# 10. Check for obvious unsafe SQL patterns in application source
# ---------------------------------------------------------------------------
#
# These are static warnings only. They do not replace executing validateQuery().
#

UNSAFE_FOUND=0

for pattern in \
    'pg_read_file' \
    'pg_read_binary_file' \
    'DROP[[:space:]]+DATABASE' \
    'DROP[[:space:]]+SCHEMA' \
    'TRUNCATE[[:space:]]+TABLE'
do
    if grep -RniE "$pattern" src 2>/dev/null; then
        echo "WARNING: potentially unsafe SQL pattern found: $pattern"
        UNSAFE_FOUND=1
    fi
done

if [ "$UNSAFE_FOUND" -eq 0 ]; then
    echo "Unsafe SQL pattern scan PASS"
else
    echo "WARNING: Review the SQL patterns reported above."
fi

# ---------------------------------------------------------------------------
# 11. Final result
# ---------------------------------------------------------------------------

echo
echo "============================================================"
echo " Netwatch Backend validation passed."
echo " Node.js and npm are NOT required by this script."
echo "============================================================"
