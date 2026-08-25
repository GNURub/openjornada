#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
pb_binary="$project_root/backend/bin/pocketbase"
test_data_dir=""
pb_pid=""
web_pid=""

cleanup() {
  if [ -n "$web_pid" ]; then
    kill "$web_pid" 2>/dev/null || true
    wait "$web_pid" 2>/dev/null || true
  fi
  if [ -n "$pb_pid" ]; then
    kill "$pb_pid" 2>/dev/null || true
    wait "$pb_pid" 2>/dev/null || true
  fi
  case "$test_data_dir" in
    /tmp/aura-e2e-??????) rm -rf -- "$test_data_dir" ;;
  esac
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

test_data_dir=$(mktemp -d /tmp/aura-e2e-XXXXXX)

mkdir -p "$project_root/backend/bin"
(cd "$project_root" && go build -o "$pb_binary" ./cmd/openjornada)

export PB_APP_NAME="Aura E2E"
export PB_PUBLIC_URL="http://127.0.0.1:4217"
export PB_ENCRYPTION_KEY="0123456789abcdef0123456789abcdef"
export PB_MCP_ENABLED="true"
export PB_MCP_INTERNAL_URL="http://127.0.0.1:8090"
export PB_PLATFORM_ENABLED="true"
export PB_SELF_SIGNUP_ENABLED="true"
export PB_SAAS_ENFORCEMENT="true"
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

if ! command -v script >/dev/null 2>&1 || ! script --version 2>&1 | grep -qi util-linux; then
  echo "El E2E del área de proveedor necesita 'script' de util-linux." >&2
  exit 1
fi

create_platform_operator() {
  operator_email=$1
  operator_name=$2
  operator_role=$3
  operator_command="\"$pb_binary\" platform operator create --dir=\"$test_data_dir\" --migrationsDir=\"$project_root/backend/pb_migrations\" --hooksDir=\"$project_root/backend/pb_hooks\" --email=\"$operator_email\" --name=\"$operator_name\" --role=\"$operator_role\""
  printf 'PlatformE2EPassword123!\nPlatformE2EPassword123!\n' | \
    script -qec "$operator_command" /dev/null >/dev/null
}

create_platform_operator "platform-admin@example.com" "Operaciones E2E" "admin"
create_platform_operator "platform-support@example.com" "Soporte E2E" "support"

"$pb_binary" serve \
  --http=127.0.0.1:8090 \
  --dir "$test_data_dir" \
  --migrationsDir "$project_root/backend/pb_migrations" \
  --hooksDir "$project_root/backend/pb_hooks" &
pb_pid=$!

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
