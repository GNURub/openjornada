#!/usr/bin/env bash
set -euo pipefail

device="${1:-/dev/ttyACM0}"
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -c "$device" ]]; then
  echo "No se ha encontrado el M5Stack en $device. Conectalo por USB y vuelve a intentarlo." >&2
  exit 1
fi

cd "$project_dir"
uv tool run --from platformio platformio run -e m5stack_dev
uv tool run --from platformio platformio run -e m5stack_dev \
  --target upload --upload-port "$device"

echo "Diagnostico cargado. En la pantalla:"
echo "  1. Comprueba las franjas roja, verde y azul."
echo "  2. Pulsa A, B y C; cada contador debe subir y sonar un tono."
echo "  3. Acerca un tag: Lecturas debe subir una sola vez."
echo "  4. Mantenlo apoyado: el contador no debe volver a subir."
echo "  5. Retiralo al menos 300 ms y acercalo de nuevo: debe subir otra vez."
echo "Abriendo monitor serie (Ctrl+C para salir)..."

exec uv tool run --from platformio platformio device monitor \
  --port "$device" --baud 115200
