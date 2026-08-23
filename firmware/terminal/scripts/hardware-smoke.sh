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

echo "Firmware cargado. Comprueba en la pantalla:"
echo "  1. No aparece 'RFID2 no detectado'."
echo "  2. Pulsa A, B y C según las etiquetas visibles y verifica el sonido."
echo "  3. Acerca un tag compatible: sólo debe aceptarse una vez."
echo "  4. Mantenlo apoyado: no debe volver a generar una acción."
echo "  5. Retíralo al menos 300 ms y acércalo de nuevo."
echo "Abriendo monitor serie (Ctrl+C para salir)..."

exec uv tool run --from platformio platformio device monitor \
  --port "$device" --baud 115200
