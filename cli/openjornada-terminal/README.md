# CLI USB de OpenJornada Terminal

`openjornada-terminal` administra por USB terminales M5Stack con firmware
OpenJornada y protocolo `OJUSB/1`. Es un binario autocontenido para Linux,
macOS y Windows en `amd64` y `arm64`; no necesita Python ni PlatformIO para el
mantenimiento ordinario.

## Instalación en Linux y macOS

El instalador oficial selecciona `amd64` o `arm64`, descarga la última release
estable, exige la línea SHA-256 exacta de `checksums.txt` y comprueba que el
archivo contiene únicamente el ejecutable y los tres avisos legales. Después
instala el binario atómicamente con modo `0755`; no usa `sudo` ni solicita
privilegios de administrador.

```bash
curl -fsSL https://github.com/GNURub/openjornada/releases/latest/download/install.sh | sh
```

El destino predeterminado es `$HOME/.local/bin`. Puede elegirse otro directorio
de usuario, incluso si su ruta contiene espacios:

```bash
curl -fsSL https://github.com/GNURub/openjornada/releases/latest/download/install.sh \
  | OPENJORNADA_INSTALL_DIR="$HOME/Mis programas/bin" sh
```

El instalador no modifica los archivos de inicio de la shell. Añade el
directorio elegido a `PATH` si aún no está incluido; para el destino
predeterminado, incorpora esta línea a `~/.profile` o al archivo equivalente de
tu shell y abre una consola nueva:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Un checksum incorrecto o un archivo con entradas inesperadas cancela la
instalación antes de sustituir un binario existente.

## Instalación en Windows

Desde PowerShell 7, el instalador oficial detecta `amd64` o `arm64` mediante el
runtime, descarga la última release estable y verifica el inventario SHA-256 y
el contenido exacto del ZIP antes de sustituir el ejecutable:

```powershell
irm https://github.com/GNURub/openjornada/releases/latest/download/install.ps1 | iex
```

Se instala únicamente para la persona actual en
`$env:LOCALAPPDATA\Programs\OpenJornada\bin` y añade esa ruta al `PATH` de
usuario de forma idempotente. No solicita elevación ni modifica el `PATH` de
máquina. Abre una nueva consola después de la primera instalación para usar el
comando sin indicar su ruta completa. Un checksum incorrecto, un inventario no
canónico o un ZIP con rutas, enlaces, duplicados, ficheros inesperados, vacíos o
sobredimensionados deja intacto cualquier ejecutable anterior.

## Verificación manual de la descarga

Los instaladores verifican SHA-256 automáticamente. Para comprobar manualmente
un paquete Unix, elige el nombre exacto correspondiente a tu sistema y
arquitectura (`linux` o `darwin`, `amd64` o `arm64`):

```bash
set -eu
base=https://github.com/GNURub/openjornada/releases/latest/download
archive=openjornada-terminal_linux_amd64.tar.gz
curl -fLO "$base/$archive"
curl -fsSLO "$base/checksums.txt"
awk -v target="$archive" '
  {
    digest = substr($0, 1, 64)
    separator = substr($0, 65, 2)
    name = substr($0, 67)
    if (length(digest) == 64 && digest !~ /[^0-9a-f]/ &&
        separator == "  " && name == target) {
      matches++
      checksum = $0
    }
  }
  END {
    if (matches != 1) exit 1
    print checksum
  }
' checksums.txt > "$archive.sha256"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c "$archive.sha256"
else
  shasum -a 256 -c "$archive.sha256"
fi
```

En Windows, PowerShell permite seleccionar y verificar el ZIP estable sin
ejecutar el instalador:

```powershell
$ErrorActionPreference = 'Stop'
$Base = 'https://github.com/GNURub/openjornada/releases/latest/download'
$Architecture = switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
  ([Runtime.InteropServices.Architecture]::X64) { 'amd64' }
  ([Runtime.InteropServices.Architecture]::Arm64) { 'arm64' }
  default { throw 'Arquitectura no compatible.' }
}
$Archive = "openjornada-terminal_windows_$Architecture.zip"
$Work = [IO.Path]::Combine(
  [IO.Path]::GetTempPath(), "openjornada-terminal-$([Guid]::NewGuid().ToString('N'))"
)
[void][IO.Directory]::CreateDirectory($Work)
try {
  $ArchivePath = [IO.Path]::Combine($Work, $Archive)
  $ChecksumsPath = [IO.Path]::Combine($Work, 'checksums.txt')
  Invoke-WebRequest "$Base/$Archive" -OutFile $ArchivePath
  Invoke-WebRequest "$Base/checksums.txt" -OutFile $ChecksumsPath
  $Pattern = '^(?<digest>[0-9a-f]{64})  ' + [regex]::Escape($Archive) + '$'
  $Entries = @(Get-Content -LiteralPath $ChecksumsPath | Where-Object { $_ -cmatch $Pattern })
  if ($Entries.Count -ne 1) { throw 'No existe una única entrada SHA-256 exacta.' }
  [void]($Entries[0] -cmatch $Pattern)
  $Expected = $Matches.digest
  $Actual = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -cne $Expected) { throw 'El checksum SHA-256 no coincide.' }
  Write-Host "SHA-256 verificado: $Archive"
}
finally {
  if ([IO.Directory]::Exists($Work)) {
    Remove-Item -LiteralPath $Work -Recurse -Force
  }
}
```

La URL `releases/latest/download` resuelve únicamente la última release
estable. Las prereleases también pueden incluir paquetes de la CLI, pero no
reemplazan ese destino ni el usado por `self-update`.

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

La rotación excepcional de la raíz Ed25519 entre firmware `1.2.0` y `1.2.1`
no puede hacerse con `firmware update`, porque `1.2.0` sólo confía en la pública
anterior. Con `pendingCount: 0`, descarga `openjornada-m5stack.bin` de la
release `v0.8.1` y usa
`openjornada-terminal firmware install openjornada-m5stack.bin --port auto`;
confirma la presencia física manteniendo sólo C. A partir de `1.2.1`, las
actualizaciones oficiales vuelven a usar `firmware update` y OTA normalmente.

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

Para actualizar una instalación existente a la última versión estable:

```bash
openjornada-terminal self-update
```

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

## Desinstalación

En Linux o macOS, elimina sólo el binario del destino usado al instalar. Para
el destino predeterminado:

```bash
rm -- "$HOME/.local/bin/openjornada-terminal"
```

Retira manualmente de tu archivo de inicio la línea de `PATH` que añadiste si
ya no usas `$HOME/.local/bin` para otros programas. No borres ese directorio si
contiene otros ejecutables.

En Windows, estos comandos validan primero el destino, eliminan sólo el
ejecutable y eliminan `bin` únicamente si queda vacío:

```powershell
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw 'LOCALAPPDATA no está definido.'
}
$InstallDir = [IO.Path]::GetFullPath(
  [IO.Path]::Combine($env:LOCALAPPDATA, 'Programs', 'OpenJornada', 'bin')
)
$Executable = [IO.Path]::Combine($InstallDir, 'openjornada-terminal.exe')
if ([IO.File]::Exists($Executable)) {
  Remove-Item -LiteralPath $Executable -Force
}
if ((Test-Path -LiteralPath $InstallDir) -and
    -not (Get-ChildItem -LiteralPath $InstallDir -Force)) {
  Remove-Item -LiteralPath $InstallDir
}
```

El instalador puede haber añadido ese directorio al `PATH` de usuario. Retira
la entrada sólo si confirmas que la añadió para OpenJornada y que no la
necesita otro programa; el siguiente bloque además exige que `bin` ya no exista:

```powershell
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw 'LOCALAPPDATA no está definido.'
}
$InstallDir = [IO.Path]::GetFullPath(
  [IO.Path]::Combine($env:LOCALAPPDATA, 'Programs', 'OpenJornada', 'bin')
)
if ([IO.Directory]::Exists($InstallDir)) {
  throw 'No se modifica PATH porque el directorio bin contiene otros archivos.'
}
$UserPath = [Environment]::GetEnvironmentVariable(
  'Path', [EnvironmentVariableTarget]::User
)
$UpdatedPath = (($UserPath -split [IO.Path]::PathSeparator) | Where-Object {
  $_ -and -not [StringComparer]::OrdinalIgnoreCase.Equals(
    $_.Trim().Trim('"').TrimEnd('\'),
    $InstallDir.TrimEnd('\')
  )
}) -join [IO.Path]::PathSeparator
[Environment]::SetEnvironmentVariable(
  'Path', $UpdatedPath, [EnvironmentVariableTarget]::User
)
```

Abre una consola nueva para que el cambio de `PATH` sea visible. El CLI no crea
archivos de configuración ni telemetría, por lo que no hay datos adicionales
propios que eliminar.

## Desarrollo

Requiere Go 1.25 o posterior:

```bash
go test -race ./...
go vet ./...
CGO_ENABLED=0 go build ./cmd/openjornada-terminal
```

El CI principal ejecuta las pruebas con detección de carreras, `go vet` y el
contrato del empaquetador. También compila con `CGO_ENABLED=0` los destinos
Linux, macOS y Windows en `amd64` y `arm64`, e inicia el binario Linux `amd64`
para comprobar la versión inyectada durante la compilación.

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
