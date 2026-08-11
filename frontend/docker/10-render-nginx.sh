#!/bin/sh
set -eu
: "${BACKEND_UPSTREAM:=http://netwatch-backend:3000}"
export BACKEND_UPSTREAM
envsubst '${BACKEND_UPSTREAM}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf
nginx -t
