# CLI USB de OpenJornada Terminal

`openjornada-terminal` administra por USB terminales M5Stack con firmware
OpenJornada y protocolo `OJUSB/1`. Es un binario autocontenido para Linux,
macOS y Windows en `amd64` y `arm64`; no necesita Python ni PlatformIO para el
mantenimiento ordinario.

## Comandos

```text
openjornada-terminal ports
openjornada-terminal status [--port PORT] [--json]
openjornada-terminal doctor [--port PORT]
openjornada-terminal logs [--port PORT] --follow
openjornada-terminal provision [--port PORT]
openjornada-terminal provision [--port PORT] --ojp-stdin
openjornada-terminal reboot [--port PORT]
openjornada-terminal factory-reset [--port PORT]
openjornada-terminal firmware check [--port PORT]
openjornada-terminal firmware update [--port PORT]
openjornada-terminal firmware install ARCHIVO.bin [--port PORT]
openjornada-terminal self-update
openjornada-terminal completion bash|zsh|fish|powershell
openjornada-terminal version
```

`--port auto` es el valor predeterminado. Selecciona el único puerto que
complete el handshake de OpenJornada y falla de forma cerrada si encuentra
cero o más de un terminal. `status`, `doctor` y los eventos de `logs` no
muestran SSID, contraseña, URL, token, UID ni IP.

## Aprovisionamiento OJP

La forma recomendada es la entrada interactiva sin eco:

```bash
openjornada-terminal provision
```

También puede leerse exactamente un OJP desde la entrada estándar, útil para
integrarlo con un gestor de secretos sin pasarlo como argumento:

```bash
printf '%s\n' "$OJP" | openjornada-terminal provision --ojp-stdin
```

PowerShell:

```powershell
$env:OJP | openjornada-terminal provision --ojp-stdin
```

Se acepta el enlace completo `http://192.168.4.1/#ojp=...`, el fragmento
`#ojp=...`, `ojp=...` o el Base64URL sin padding. No existe `--ojp VALOR`: un
argumento quedaría visible en el historial y en el listado de procesos. Evita
guardar el OJP en archivos o variables permanentes. El CLI descarta sus
referencias al terminar, pero Go no garantiza el borrado criptográfico de la
memoria.

El terminal debe estar en aprovisionamiento. En uno ya configurado, mantén
`A+B` durante cinco segundos para abrir ese modo sin borrar configuración,
caché ni fichajes pendientes.

## Acceso USB

En Linux, el usuario debe tener permiso sobre el puerto serie. Según la
distribución, añádelo al grupo que posee el dispositivo y vuelve a iniciar
sesión:

```bash
sudo usermod -aG dialout "$USER"
```

Algunas distribuciones usan `uucp` en lugar de `dialout`; confirma el grupo con
`ls -l /dev/ttyACM0` o la ruta mostrada por `openjornada-terminal ports`. No
ejecutes el CLI como root para eludir permisos.

Los binarios iniciales no están firmados con Apple Developer ID ni
Authenticode. macOS Gatekeeper o Windows SmartScreen pueden advertirlo. Verifica
que el archivo procede de la release oficial y que su SHA-256 coincide con
`checksums.txt` antes de autorizar su ejecución.

## Firmware y acciones destructivas

`firmware update` sólo instala una release oficial estable después de verificar
localmente Ed25519, placa, protocolo, SemVer, tamaño y SHA-256. El terminal
repite esas validaciones. `firmware install ARCHIVO.bin` acepta únicamente una
compilación compatible de OpenJornada, muestra que no es oficial y exige
mantener sólo `C` durante cinco segundos en la pantalla física. La solicitud
caduca a los 30 segundos.

`factory-reset` muestra primero el número de fichajes pendientes y también
exige mantener sólo `C` durante cinco segundos. La presencia física reduce
ejecuciones accidentales; no identifica a la persona operadora ni constituye
una firma electrónica. El restablecimiento elimina configuración, caché, cola
y estado local, pero conserva el firmware y la tabla de particiones.

Las instalaciones de firmware se rechazan si hay fichajes pendientes o una
acción incompatible en curso. Sincroniza la cola antes de actualizar; el CLI
no ofrece una opción para ignorar esa protección.

Si el firmware no llega a arrancar ni a exponer `OJUSB/1`, este CLI no puede
recuperarlo. Usa el procedimiento técnico documentado en
[`firmware/terminal/README.md`](../../firmware/terminal/README.md) con
PlatformIO/esptool, una placa de laboratorio y una copia restaurable.

## Actualización y completado

`self-update` selecciona el archivo exacto para el sistema y arquitectura,
descarga también `checksums.txt` por HTTPS desde hosts de GitHub permitidos,
verifica SHA-256 antes de extraer y sólo acepta el binario junto con `LICENSE`,
`NOTICE` y `THIRD_PARTY_NOTICES`. En Unix sustituye atómicamente el ejecutable;
en Windows prepara el reemplazo para cuando termine el proceso actual. Nunca
ejecuta scripts descargados.

Ejemplos de instalación del completado en la sesión actual:

```bash
source <(openjornada-terminal completion bash)
source <(openjornada-terminal completion zsh)
openjornada-terminal completion fish | source
```

```powershell
openjornada-terminal completion powershell | Out-String | Invoke-Expression
```

La generación de completado es reproducible y no abre dispositivos ni accede a
la red.

## Desarrollo

Requiere Go 1.25 o posterior:

```bash
go test -race ./...
go vet ./...
CGO_ENABLED=0 go build ./cmd/openjornada-terminal
```

Para crear un archivo de release reproducible y su inventario SHA-256:

```bash
python3 scripts/package_release.py --binary dist/openjornada-terminal \
  --os linux --arch amd64 --license ../../LICENSE --notice ../../NOTICE \
  --third-party THIRD_PARTY_NOTICES --output dist/release
python3 scripts/checksums.py dist/release/*.tar.gz dist/release/*.zip \
  --output dist/release/checksums.txt
```

El empaquetador sólo acepta las seis combinaciones publicadas, incluye
exactamente el binario y los tres avisos legales, y no sobrescribe salidas.
Los scripts requieren únicamente la biblioteca estándar de Python 3.

El CLI no crea archivos de configuración ni telemetría. Las licencias de Go y
de los módulos enlazados se recogen en `THIRD_PARTY_NOTICES`.
