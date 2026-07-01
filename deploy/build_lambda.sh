#!/usr/bin/env bash
# Build deploy/lambda.zip for the arm64 python3.11 Lambda runtime.
#
# Dependencies are resolved as manylinux2014_aarch64 wheels (Lambda's
# python3.11 runtime is Amazon Linux 2 / glibc 2.26 on Graviton, so
# manylinux2014 == glibc 2.17 wheels are the safe ceiling). --only-binary
# guarantees nothing is compiled on this Mac for the wrong platform.
set -euo pipefail
cd "$(dirname "$0")/.."

# CI runners have no .venv; point PIP at their interpreter's pip instead.
PIP="${PIP:-.venv/bin/pip}"

BUILD=deploy/build
ZIP=deploy/lambda.zip
rm -rf "$BUILD" "$ZIP"
mkdir -p "$BUILD"

"$PIP" install \
    --quiet \
    --platform manylinux2014_aarch64 \
    --platform manylinux_2_17_aarch64 \
    --implementation cp \
    --python-version 3.11 \
    --only-binary=:all: \
    --target "$BUILD" \
    -r deploy/requirements-lambda.txt

# plaid-python is sdist-only (pure Python), which pip refuses to resolve
# cross-platform; install it natively without deps (deps pinned in phase 1).
"$PIP" install --quiet --target "$BUILD" --no-deps plaid-python==39.2.0

# App modules only. link_helper.py (local-only Plaid Link helper) and
# sandbox_link.py must never ship; .env is excluded by construction.
cp server.py plaid_client.py storage.py sync.py analytics.py \
   secure_tokens.py tagging.py gamify.py wealth.py insights.py \
   planner.py newsroom.py config_secrets.py lambda_app.py "$BUILD/"

if [ -e "$BUILD/.env" ]; then
    echo "refusing to package .env" >&2
    exit 1
fi

find "$BUILD" -name "__pycache__" -type d -prune -exec rm -rf {} +
find "$BUILD" -name "*.dist-info" -type d -exec rm -rf {}/RECORD \; 2>/dev/null || true
(cd "$BUILD" && zip -qr "../$(basename "$ZIP")" .)

ls -lh "$ZIP"
echo "unzipped size: $(du -sh "$BUILD" | cut -f1)"
