#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_data_dir=$(mktemp -d /tmp/aura-e2e-XXXXXX)
pb_binary="$project_root/backend/bin/pocketbase"

if [ ! -x "$pb_binary" ]; then
  echo "PocketBase binary missing at $pb_binary" >&2
  exit 1
fi

export PB_APP_NAME="Aura E2E"
export PB_PUBLIC_URL="http://127.0.0.1:4217"
export PB_ORGANIZATION_NAME="Centro Aura Test"
export PB_ORGANIZATION_TAX_ID="TEST000000"
export PB_BOOTSTRAP_ADMIN_EMAIL="admin@example.com"
export PB_BOOTSTRAP_ADMIN_PASSWORD="TestPassword123!"
export PB_DEMO_ENABLED="true"
export PB_DEMO_EMAIL="empleada@example.com"
export PB_DEMO_PASSWORD="DemoPassword123!"

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

cleanup() {
  kill "$pb_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cd "$project_root/web"
exec npm start -- --host 127.0.0.1 --port 4217
