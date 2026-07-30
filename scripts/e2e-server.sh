#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_data_dir=$(mktemp -d /tmp/aura-e2e-XXXXXX)
pb_binary="$project_root/backend/bin/pocketbase"

mkdir -p "$project_root/backend/bin"
(cd "$project_root" && go build -o "$pb_binary" ./cmd/openjornada)

export PB_APP_NAME="Aura E2E"
export PB_PUBLIC_URL="http://127.0.0.1:4217"
export PB_ENCRYPTION_KEY="0123456789abcdef0123456789abcdef"
export PB_MCP_ENABLED="true"
export PB_MCP_INTERNAL_URL="http://127.0.0.1:8090"
export PB_ORGANIZATION_NAME="Centro Aura Test"
export PB_ORGANIZATION_TAX_ID="TEST000000"
export PB_BOOTSTRAP_ADMIN_EMAIL="admin@example.com"
export PB_BOOTSTRAP_ADMIN_PASSWORD="TestPassword123!"
export PB_DEMO_ENABLED="true"
export PB_DEMO_EMAIL="empleada@example.com"
export PB_DEMO_PASSWORD="DemoPassword123!"
export PB_MAIL_SENDER_NAME="Aura E2E"
export PB_MAIL_SENDER_ADDRESS="no-reply@example.com"
export PB_SMTP_HOST="127.0.0.1"
export PB_SMTP_PORT="1026"
export PB_SMTP_TLS="false"

"$pb_binary" migrate up \
  --dir "$test_data_dir" \
  --migrationsDir "$project_root/backend/pb_migrations" \
  --hooksDir "$project_root/backend/pb_hooks"

"$pb_binary" serve \
  --http=127.0.0.1:8090 \
  --dir "$test_data_dir" \
  --migrationsDir "$project_root/backend/pb_migrations" \
  --hooksDir "$project_root/backend/pb_hooks" &
pb_pid=$!
web_pid=""

cleanup() {
  if [ -n "$web_pid" ]; then
    kill "$web_pid" 2>/dev/null || true
  fi
  kill "$pb_pid" 2>/dev/null || true
  wait "$web_pid" 2>/dev/null || true
  wait "$pb_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sleep 1
if ! kill -0 "$pb_pid" 2>/dev/null; then
  wait "$pb_pid" 2>/dev/null || true
  echo "PocketBase E2E no pudo arrancar; comprueba que el puerto 8090 esté libre." >&2
  exit 1
fi

cd "$project_root/web"
pnpm start --host 127.0.0.1 --port 4217 &
web_pid=$!
wait "$web_pid"
