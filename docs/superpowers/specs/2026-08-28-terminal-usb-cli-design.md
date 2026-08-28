# Diseño del CLI USB del terminal

**Fecha:** 2026-08-28
**Estado:** aprobado
**Componentes:** firmware M5Stack, CLI Go y GitHub Actions

## Objetivo

Permitir administrar por USB un terminal OpenJornada desde Windows, macOS o
Linux sin depender del portal cautivo. El CLI podrá aprovisionar mediante el
payload `ojp`, consultar y diagnosticar el terminal, instalar firmware oficial
o personalizado, reiniciar y ejecutar un restablecimiento de fábrica con
confirmación física.

El ejecutable se llamará `openjornada-terminal`, no requerirá Python ni
PlatformIO y se distribuirá como binario autocontenido en las mismas GitHub
Releases que la aplicación y el firmware.

## Alcance

La primera versión incluirá:

- descubrimiento de puertos y handshake con terminales OpenJornada;
- estado y diagnóstico sin revelar secretos;
- logs estructurados y saneados por USB;
- aprovisionamiento con enlace completo, fragmento o payload `ojp`;
- reinicio ordinario;
- actualización al firmware oficial estable más reciente;
- instalación de un firmware OpenJornada personalizado compatible;
- restablecimiento completo de los datos locales;
- actualización del propio CLI;
- generación de completado para shells;
- artefactos, checksums, procedencia e instaladores para los tres sistemas.

No incluye:

- recuperación de una placa cuyo firmware no llegue a arrancar;
- flasheo del bootloader o de la tabla de particiones;
- instalación silenciosa de firmware arbitrario que no implemente el contrato
  de arranque y rollback de OpenJornada;
- administración remota por red;
- persistencia de contraseñas, API keys o payloads `ojp` en el ordenador.

Una placa que no arranque seguirá recuperándose con PlatformIO/esptool por USB.

## Estructura del proyecto

El CLI vivirá en un módulo Go independiente:

```text
cli/openjornada-terminal/
├── cmd/openjornada-terminal/main.go
├── internal/app/
├── internal/ojp/
├── internal/protocol/
├── internal/release/
├── internal/serialport/
├── internal/update/
├── install.sh
├── install.ps1
├── go.mod
├── go.sum
└── README.md
```

Separar el módulo evita incorporar dependencias de puerto serie al backend. El
CLI usará Cobra v1.10.2 para los subcomandos, `go.bug.st/serial` v1.8.0 para el
puerto serie y `golang.org/x/term` v0.45.0 para entrada interactiva sin eco. Usará la
enumeración portable de nombres, no el subpaquete de metadatos USB que exige
CGO en macOS.

El firmware añadirá unidades pequeñas y portables:

```text
firmware/terminal/
├── include/openjornada/usb_protocol.hpp
├── include/openjornada/usb_maintenance.hpp
├── include/openjornada/ojp.hpp
├── include/openjornada/firmware_metadata.hpp
├── src/domain/usb_protocol.cpp
├── src/domain/ojp.cpp
├── src/network/usb_firmware_receiver.cpp
└── src/app/usb_maintenance.cpp
```

## Comandos del CLI

### Descubrimiento y diagnóstico

```text
openjornada-terminal ports
openjornada-terminal status [--port PORT]
openjornada-terminal doctor [--port PORT]
openjornada-terminal logs [--port PORT] --follow
openjornada-terminal version
```

`ports` enumera puertos y sólo identifica un dispositivo después de completar
el handshake. `--port auto` será el valor predeterminado: selecciona el único
terminal compatible y falla de forma explícita si no hay ninguno o hay varios.

`status` muestra placa, versión, protocolo, modo actual, presencia de
configuración, conexión Wi-Fi, número de fichajes pendientes y capacidades. No
muestra SSID, contraseña, URL, token, UID ni IP.

`doctor` comprueba apertura del puerto, handshake, versión del protocolo,
compatibilidad de placa y disponibilidad de cada capacidad. Sus mensajes serán
accionables y no incluirán bytes recibidos sin sanear.

`logs --follow` muestra exclusivamente eventos estructurados permitidos. El
firmware no emitirá contraseñas, tokens, UIDs, IP, documentos ni contenido de
peticiones HTTP.

### Aprovisionamiento

```text
openjornada-terminal provision [--port PORT]
openjornada-terminal provision [--port PORT] --ojp-stdin
```

Sin `--ojp-stdin`, el CLI solicita pegar el valor sin eco. Acepta:

- `http://192.168.4.1/#ojp=<payload>`;
- `#ojp=<payload>`;
- `ojp=<payload>`;
- el Base64URL sin padding.

No habrá opción `--ojp <valor>` porque los argumentos quedan expuestos en el
historial del shell y en el listado de procesos. El CLI valida localmente el
contrato v1 antes de transmitirlo, pero el firmware vuelve a decodificar y
validar el mismo contrato.

El comando sólo se acepta cuando el terminal muestra el modo de configuración.
En un terminal ya configurado se entra manteniendo `A+B` durante cinco
segundos. El candidato pasa por las validaciones actuales de URL y credenciales,
se conecta a la Wi-Fi, ejecuta `bootstrap` y únicamente después se persiste. Un
cambio de API key sigue rechazándose si hay fichajes pendientes.

### Reinicio y restablecimiento

```text
openjornada-terminal reboot [--port PORT]
openjornada-terminal factory-reset [--port PORT]
```

`reboot` no cambia datos y responde antes de reiniciar.

`factory-reset` solicita al terminal el recuento de fichajes pendientes, lo
muestra en la consola y abre una confirmación en la pantalla física. La persona
debe mantener sólo `C` durante cinco segundos. La liberación, otro botón o un
timeout de 30 segundos cancelan la operación.

Tras confirmar, se eliminan configuración, runtime, caché de empleados y tags,
outbox y estado transitorio local; se conserva el firmware instalado y la tabla
de particiones. El terminal reinicia en aprovisionamiento. La consola nunca
presentará esta acción como reversible.

### Firmware

```text
openjornada-terminal firmware check [--port PORT]
openjornada-terminal firmware update [--port PORT]
openjornada-terminal firmware install ARCHIVO.bin [--port PORT]
```

`firmware check` compara la versión del terminal con la última GitHub Release
estable sin modificar el dispositivo.

`firmware update` descarga `openjornada-m5stack-manifest.json`, su firma y el
binario. El CLI verifica Ed25519, placa, protocolo, SemVer, tamaño y SHA-256 con
la misma clave pública incorporada por el firmware. El terminal repite todas
las comprobaciones antes de escribir el slot inactivo.

`firmware install` calcula tamaño y SHA-256 y exige que el binario contenga un
bloque de metadatos OpenJornada v1 con placa, protocolo y versión. Antes de
aceptar bytes, el terminal muestra la advertencia de firmware personalizado y
exige mantener sólo `C` durante cinco segundos. El timeout será de 30 segundos.

Las dos instalaciones:

- se rechazan si existen fichajes pendientes;
- se rechazan durante una acción, sesión administrativa u otra actualización;
- escriben exclusivamente el slot OTA inactivo mediante `Update`;
- verifican el hash después de escribir;
- guardan versión y hash antes de seleccionar el nuevo slot;
- reinician y sólo confirman el slot después de inicializar almacenamiento,
  configuración y aplicación;
- permiten que el bootloader revierta ante fallo.

El firmware personalizado debe ser una compilación compatible de OpenJornada.
Una imagen que no implemente la validación de arranque será revertida.

### Actualización y completado del CLI

```text
openjornada-terminal self-update
openjornada-terminal completion bash|zsh|fish|powershell
```

`self-update` descarga la última release estable correspondiente al sistema y
arquitectura, verifica `checksums.txt` y sustituye el ejecutable. En Windows deja
un proceso auxiliar temporal que reemplaza el `.exe` después de que termine el
proceso actual. No ejecuta scripts descargados.

## Protocolo USB OJUSB/1

El puerto inicial opera a 115200 baudios, 8-N-1. El CLI no asume que un VID/PID
identifica el terminal: abre candidatos sin activar DTR/RTS y exige handshake.

Los mensajes de control son una línea ASCII con prefijo `OJUSB/1 ` seguido de
JSON UTF-8 compacto. El máximo es 4096 bytes incluyendo prefijo y salto de
línea. Se acepta `LF` o `CRLF`; NUL, texto malformado, campos desconocidos,
duplicados y mensajes sobredimensionados se rechazan.

Petición:

```json
{"v":1,"id":"AZaztV6Dql5aZQHCF4yzEA","command":"status","payload":{}}
```

Respuesta o evento:

```json
{"v":1,"id":"AZaztV6Dql5aZQHCF4yzEA","type":"result","code":"ok","message":"Terminal disponible","data":{}}
```

`id` es una cadena Base64URL aleatoria de 16 bytes y permite correlacionar una
única petición activa. Los códigos son estables y las frases españolas son
sólo informativas. El terminal acepta una operación mutante a la vez.

El handshake `hello` devuelve `protocolVersion`, `board`, `firmwareVersion`,
`mode` y capacidades. El CLI ignora líneas sin el prefijo y el firmware no
interpreta como comando ninguna línea que no cumpla el framing completo.

### Transferencia binaria

Tras aceptar `firmware_begin`, el puerto cambia de forma negociada a 460800
baudios; si la reapertura falla, ambas partes vuelven a 115200. Cada frame usa:

```text
magic       4 bytes  "OJFW"
offset      4 bytes  uint32 little-endian
length      2 bytes  uint16 little-endian, 1..2048
crc32       4 bytes  CRC-32 IEEE del payload
payload     N bytes
```

El terminal confirma cada frame con `firmware_ack` y el siguiente offset
esperado. El host reintenta como máximo tres veces el mismo frame. Un offset
inesperado, CRC incorrecto, cinco segundos sin progreso o desconexión abortan
`Update`, conservan el slot vigente y eliminan el estado pendiente.

El commit vuelve al framing de control, verifica tamaño y SHA-256 y sólo
entonces selecciona el slot nuevo. Nunca se incluyen bytes del firmware ni
credenciales en mensajes de error.

## Estados y concurrencia

El servicio USB será no bloqueante en el bucle normal. Los comandos de lectura
no alteran pantalla ni sonido. Durante una transferencia o confirmación física:

- se suspende la entrada RFID y de botones de fichaje;
- se siguen atendiendo watchdog, pantalla y puerto serie;
- se muestra progreso acotado;
- `C` sólo actúa como confirmación cuando la pantalla lo solicita;
- cancelar restaura la pantalla anterior.

El aprovisionamiento USB se integra en el mismo bucle del portal cautivo para
reutilizar `ProvisioningAttemptState`, la conexión Wi-Fi y `bootstrap`; no crea
una segunda ruta de persistencia.

## Distribución

Un workflow `publish-terminal-cli.yml`, disparado por `release.published`,
compilará:

| Sistema | Arquitecturas | Archivo |
| --- | --- | --- |
| Linux | amd64, arm64 | `.tar.gz` |
| macOS | amd64, arm64 | `.tar.gz` |
| Windows | amd64, arm64 | `.zip` |

Los nombres serán
`openjornada-terminal_<os>_<arch>.<ext>`; la versión queda fijada por la GitHub
Release y dentro del binario. Cada archivo contendrá el
binario, `LICENSE`, `NOTICE` y las licencias de dependencias aplicables.

La release publicará además `checksums.txt`, `install.sh` e `install.ps1`. Los
workflows fijarán las Actions por SHA, usarán permisos mínimos, compilarán desde
la etiqueta publicada y generarán atestación de procedencia.

Instalación Unix:

```bash
curl -fsSL https://github.com/GNURub/openjornada/releases/latest/download/install.sh | sh
```

Instalación PowerShell:

```powershell
irm https://github.com/GNURub/openjornada/releases/latest/download/install.ps1 | iex
```

Ambos instaladores detectan OS/arquitectura, descargan archivo y checksums,
verifican SHA-256 antes de extraer y usan un directorio de usuario. Nunca piden
ni almacenan el payload `ojp`. Inicialmente los binarios no tendrán Apple
Developer ID ni Authenticode, por lo que los sistemas pueden mostrar avisos.

## Seguridad y privacidad

- Ningún secreto se acepta como argumento del proceso.
- El payload `ojp` vive sólo en memoria y sus referencias se descartan al
  terminar; Go no ofrece garantía de borrado criptográfico de la memoria.
- El CLI no crea archivos de configuración ni telemetría.
- Firmware y CLI validan longitudes antes de reservar memoria.
- Los mensajes de error usan códigos acotados; no reflejan entrada arbitraria.
- Sólo firmware oficial con firma válida evita la confirmación física.
- Firmware personalizado y factory reset exigen presencia física.
- Los comandos de firmware se rechazan con fichajes pendientes.
- El reset informa de los pendientes antes de permitir su pérdida explícita.
- El CLI verifica checksums de sus propias descargas.
- La clave pública del CLI debe coincidir byte a byte con la del firmware.

## Pruebas y aceptación

### Firmware nativo

- parser incremental con fragmentación, CRLF, límites y recuperación;
- contrato estricto de comandos y respuestas;
- decoder `ojp` con los mismos vectores del frontend;
- confirmación física, timeout, cancelación y rollover de `millis()`;
- políticas de modo, concurrencia y fichajes pendientes;
- frames binarios, offsets, CRC, timeout y reintentos;
- transición OTA, hash, abort y rollback.

### CLI Go

- normalización y validación de todos los formatos `ojp`;
- selección automática de cero, uno o varios puertos;
- transporte fragmentado y timeouts con un puerto simulado;
- redacción de errores;
- verificación de manifiesto, Ed25519, SHA y metadatos;
- instalación y self-update con servidor HTTP temporal;
- compilación con `CGO_ENABLED=0` para las seis plataformas.

### Físicas

- provisionar la placa borrada desde Linux por USB;
- repetir en al menos un host Windows o macOS antes de cerrar la primera
  release pública;
- actualizar firmware oficial conservando configuración;
- instalar build personalizado y comprobar rollback;
- cancelar una confirmación física;
- restablecer con y sin pendientes;
- desconectar USB durante una transferencia y verificar que sigue arrancando el
  slot anterior.

### Criterios finales

- Ninguna prueba o log contiene el token, contraseña, UID o payload completo.
- El portal cautivo existente sigue funcionando.
- Los fichajes y la sincronización no se degradan cuando el CLI no está activo.
- Los seis artefactos se descargan, verifican y muestran la versión de release.
- Los instaladores fallan de forma cerrada ante checksum incorrecto.
- La documentación de firmware, despliegue, funcionalidades y cumplimiento se
  actualiza en la misma entrega.
