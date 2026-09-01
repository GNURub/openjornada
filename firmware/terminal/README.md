# Firmware del terminal M5Stack RFID

Firmware USB para M5Stack Basic Core v2.7 (K001-V27) con Unit RFID2
(U031-B). Usa el contrato `/api/openjornada/terminal/v1`; PocketBase sigue
siendo la autoridad sobre personas, estados, horas efectivas e incidencias.

## Conexión y requisitos

Conecta RFID2 al puerto Grove A:

| RFID2 | M5Stack |
| --- | --- |
| negro (GND) | GND |
| rojo (5 V) | 5 V |
| amarillo (SDA) | GPIO 21 |
| blanco (SCL) | GPIO 22 |

El lector usa I²C `0x28` y tags ISO/IEC 14443A de 13,56 MHz. Los tags de
125 kHz no son compatibles. No se necesita microSD.

PlatformIO se ejecuta mediante `uv`; ambos se instalan de forma aislada al
usar los comandos siguientes:

```bash
cd firmware/terminal
python3 -m unittest scripts/test_validate_partitions.py scripts/test_release_firmware.py
uv tool run --from platformio==6.1.19 platformio test -e native -f test_usb_protocol
uv tool run --from platformio==6.1.19 platformio test -e native
uv tool run --from platformio==6.1.19 platformio run -e m5stack_dev
uv tool run --from platformio==6.1.19 platformio run -e m5stack_dev --target upload --upload-port /dev/ttyACM0
uv tool run --from platformio==6.1.19 platformio device monitor --port /dev/ttyACM0 --baud 115200
uv tool run --from platformio==6.1.19 platformio run -e m5stack_release
```

El benchmark destructivo de cola llena sólo debe ejecutarse sobre una placa de
pruebas sin fichajes pendientes; usa el entorno `m5stack_benchmark`, genera
10.000 registros sintéticos, mide los recorridos cooperativos y los elimina al
terminar.

El usuario debe tener lectura y escritura sobre el puerto serie. En Linux se
recomienda pertenecer a `dialout` y volver a iniciar sesión; para identificar la
placa sin depender del número ACM puede usarse el enlace estable de
`/dev/serial/by-id/` como valor de `--upload-port`.

El artefacto de producción queda en
`.pio/build/m5stack_release/firmware.bin`. `m5stack_release` sólo permite
HTTPS y valida la cadena del servidor con el bundle de CA del ESP32. La primera
instalación de la versión 1.2.0 requiere USB para activar el layout A/B.

La transición de `1.2.0` a `1.2.1` es una excepción: rota la raíz Ed25519
porque la privada anterior se perdió. Un terminal `1.2.0` conserva la pública
antigua y, por diseño, rechazará el manifiesto nuevo; `firmware update` no puede
cruzar esta rotación. Sincroniza primero todos los fichajes y comprueba
`pendingCount: 0`. Después flashea `m5stack_release` por USB o instala el
`openjornada-m5stack.bin` de la release con
`openjornada-terminal firmware install openjornada-m5stack.bin --port auto` y
mantén sólo C cuando lo solicite. Ambas vías conservan NVS y LittleFS. Una vez
instalado `1.2.1`, las versiones posteriores vuelven a descargarse
automáticamente desde la última GitHub Release estable.

La carga USB conserva NVS y LittleFS, escribe la aplicación en `ota_0` y
reubica el inicializador `boot_app0.bin` a la partición `otadata` de `0x3f0000`,
evitando su offset predeterminado `0xe000`, que solaparía NVS. El firmware nunca
puede superar el 85 % de cada slot de `0x1f0000`. Sólo un restablecimiento con
confirmación física —iniciado con A+B+C o mediante `factory-reset` USB— o un
borrado completo solicitado expresamente elimina credenciales, caché y cola.

## Actualizaciones OTA

Una vez por hora, el perfil `m5stack_release` consulta en segundo plano el
manifiesto firmado de `GNURub/openjornada`. Sólo instala una versión SemVer
superior para `m5stack-basic-core-v27`, protocolo 1 y canal `stable`. El
manifiesto debe tener
una firma Ed25519 válida y el binario debe coincidir en tamaño y SHA-256.

La instalación espera a que no haya fichajes pendientes, trabajos de red ni
sesión administrativa, y exige dos minutos sin interacción, Wi-Fi, reloj fiable
y evidencia compatible reciente: el `bootstrap` inicial y cada heartbeat
autenticado correcto la renuevan. La telemetría usa un worker independiente y
no bloquea botones ni lecturas RFID; sus fallos son silenciosos. Justo antes de
descargar se vuelven a comprobar todas las condiciones. Una instalación real
muestra su progreso, escribe el slot inactivo y reinicia. Si el nuevo firmware
no supera la autocomprobación local, el bootloader recupera la versión anterior
y bloquea esa combinación de versión y hash para evitar bucles.

`m5stack_dev` no consulta actualizaciones. Para pruebas aisladas usa
`m5stack_ota_test` y define antes de compilar:

```bash
export OJ_OTA_TEST_MANIFEST_URL='http://192.168.1.20:8765/openjornada-m5stack-manifest.json'
export OJ_OTA_TEST_PUBLIC_KEY_HEX='64-caracteres-hex-de-la-clave-publica'
uv tool run --from platformio==6.1.19 platformio run -e m5stack_ota_test
```

La clave privada de pruebas no debe entrar en Git. La privada de producción se
guarda exclusivamente como secreto `FIRMWARE_SIGNING_PRIVATE_KEY_B64` de
GitHub Actions. Cada release estable contiene binario, manifiesto, firma y
licencias. USB sigue siendo siempre el mecanismo de recuperación.

## Mantenimiento por USB (`OJUSB/1`)

El firmware atiende por el mismo puerto serie un protocolo de mantenimiento
acotado. La CLI prevista se llama `openjornada-terminal` y expone estos comandos
sin requerir Python ni PlatformIO en el equipo operador:

```text
openjornada-terminal ports
openjornada-terminal status [--port PORT]
openjornada-terminal doctor [--port PORT]
openjornada-terminal logs [--port PORT] --follow
openjornada-terminal provision [--port PORT]
openjornada-terminal provision [--port PORT] --ojp-stdin
openjornada-terminal reboot [--port PORT]
openjornada-terminal factory-reset [--port PORT]
openjornada-terminal firmware check [--port PORT]
openjornada-terminal firmware update [--port PORT]
openjornada-terminal firmware install ARCHIVO.bin [--port PORT]
openjornada-terminal version
openjornada-terminal self-update
openjornada-terminal completion bash|zsh|fish|powershell
```

`--port auto` es el valor predeterminado y sólo continúa cuando el handshake
identifica un único terminal compatible. `status` y `doctor` son de lectura y
no alteran pantalla ni sonido. `logs --follow` sólo recibe códigos estructurados
saneados. El protocolo define los modos `booting`, `ready`, `blocked`,
`provisioning`, `updating` y `await_physical_confirmation`. Durante el portal el
adaptador serie restringido atiende `hello`, `status`, `doctor` y `provision`.
Así, tanto la autodetección como `--port` verifican el handshake antes de enviar
el OJP. `status` informa `mode: provisioning`, configuración, conectividad y
pendientes; `doctor` conserva el contrato público del runtime y ninguna de esas
respuestas incluye credenciales, IP ni UID.

El valor OJP se pega mediante entrada interactiva sin eco o `--ojp-stdin`.
Deliberadamente no existe `--ojp VALOR`: los argumentos pueden quedar en el
historial y en el listado de procesos. El terminal sólo acepta `provision` en
modo `provisioning`; para entrar desde una configuración existente, mantén A+B
cinco segundos. Se reutilizan la validación Wi-Fi, `bootstrap` y persistencia
del portal, y un cambio de API key se rechaza mientras haya fichajes pendientes.

Una placa nueva entra en el portal automáticamente. Desde una configuración
existente, mantén A+B cinco segundos, ejecuta
`openjornada-terminal provision --ojp-stdin` y deja que la CLI detecte el puerto
o indica uno explícito. El terminal responde primero a `hello`, acepta el OJP y
emite los eventos saneados `connecting`, `validating` y `saved` usando el mismo
flujo de validación y guardado que el portal web.

Las mutaciones aplican estas barreras:

- `reboot` responde antes de reiniciar y no borra datos.
- `factory-reset` muestra el recuento de pendientes y exige soltar todos los
  botones y mantener **sólo C durante cinco segundos**. Otro botón, soltar C o
  agotar 30 segundos cancela. Si se confirma, borra configuración, caché, tags y
  outbox; no es reversible y no debe confundirse con un reinicio.
- `firmware update` sólo acepta una release oficial cuya firma Ed25519,
  manifiesto, placa, protocolo, SemVer, tamaño y SHA-256 validen tanto la CLI
  como el terminal. Una firma oficial válida evita la confirmación física.
- `firmware install` exige una compilación compatible de OpenJornada con un
  único bloque `OJFW_META_V1`, placa `m5stack-basic-core-v27`, protocolo 1 y una
  versión SemVer. Antes de recibir el binario exige mantener **sólo C durante
  cinco segundos**, también con caducidad de 30 segundos. Un binario que no
  implemente la autocomprobación y rollback de OpenJornada no es compatible.
- Toda instalación se rechaza con el código `pending_actions` si existe al menos
  un fichaje pendiente, y también se rechaza si hay una acción, sesión
  administrativa o actualización incompatible en curso. Nunca fuerces la
  actualización borrando la cola: sincronízala y resuelve antes sus incidencias.

`OJUSB/1` empieza a 115200 baudios. La transferencia de firmware negocia 460800
y vuelve a 115200 si la reapertura falla. Las líneas de control admiten como
máximo 4096 bytes, incluido prefijo y salto de línea; cada frame lleva hasta
2048 bytes y CRC-32 IEEE. Un CRC inválido permite reintentar el mismo frame como
máximo tres veces; un offset inesperado aborta inmediatamente. Agotar esos
reintentos, desconectar o pasar cinco segundos sin progreso aborta el slot
inactivo.
Las respuestas no reflejan OJP, contraseñas, API keys, UIDs, IP ni bytes del
firmware; esos datos tampoco deben copiarse a tickets o informes de aceptación.

### Recuperación cuando no hay handshake

La CLI no flashea bootloader ni tabla de particiones. Si el firmware no arranca
o no responde a `ports`/`doctor`, usa una placa bajo custodia y recupera el build
completo con el PlatformIO fijado por el proyecto:

```bash
cd firmware/terminal
PORT=/dev/serial/by-id/usb-dispositivo-de-laboratorio
uv tool run --from platformio==6.1.19 platformio run -e m5stack_release
uv tool run --from platformio==6.1.19 platformio run -e m5stack_release \
  --target upload --upload-port "$PORT"
```

PlatformIO invoca `esptool` con la tabla y offsets comprobados por
`validate_partitions.py`. Si ni siquiera puede abrir el cargador ROM, `esptool`
sólo debe usarse siguiendo el procedimiento del fabricante para diagnosticar
puerto, cable y modo de descarga. No improvises offsets ni ejecutes
`erase_flash`: un borrado completo destruye NVS, LittleFS, credenciales, caché y
fichajes pendientes. La recuperación directa queda fuera de `OJUSB/1`.

### Lista física reproducible no destructiva

Ejecuta esta aceptación sobre una placa de laboratorio, un backend demo aislado
y una credencial exclusiva. No confirma ningún reset ni escribe un slot OTA:

1. Anota fecha, sistema operativo, ruta estable del puerto, versión esperada y
   sólo el resultado `PASS`/`FAIL` con códigos de error acotados. No anotes OJP,
   SSID, API key, UID, IP ni salida serie sin sanear.
2. Ejecuta `ports`, `status`, `doctor` y `logs --follow`. Comprueba handshake,
   placa/protocolo, diagnósticos y que los eventos no contienen secretos.
3. Mantén A+B para abrir el portal y ejecuta `provision --ojp-stdin` con
   credenciales demo. Comprueba que `hello` detecta `mode: provisioning`, que
   aparecen `connecting`, `validating` y `saved`, y que nunca se imprime el OJP.
   Tras el reinicio, `status` debe mostrar `ready` y configuración presente.
   Repite sólo en un dispositivo cuya configuración pueda cambiar.
4. Ejecuta `factory-reset`, suelta los botones y no mantengas C. Cancela desde
   la CLI o espera 30 segundos; espera `physical_confirmation_cancelled` o
   `physical_confirmation_timeout` y comprueba con `status` que configuración y
   `pendingCount` no cambiaron.
5. Ejecuta `firmware install ARCHIVO-COMPATIBLE.bin` con la misma versión de
   laboratorio y cancela antes de mantener C. Comprueba que no comenzó la
   transferencia, que la versión sigue igual y que el modo vuelve al anterior.
6. Para probar el rechazo oficial, prepara el terminal con una release oficial
   anterior que ya implemente `OJUSB/1` y tenga otra estable firmada más nueva.
   En la organización demo crea una
   persona, un tag y una credencial exclusivos de prueba; no anotes su UID ni
   secretos. Conecta, espera a `bootstrap` y NTP y no cortes la red hasta que
   termine **Actualizando credenciales locales…** y vuelva la pantalla inactiva.
   Corta entonces sólo la red del banco, presenta una vez el tag y confirma en
   pantalla una acción offline sintética;
   comprueba con `status` que `pendingCount` vale 1. Ejecuta `firmware update`: debe
   responder `pending_actions` antes de transferir bytes. Restaura la red y deja
   que esa acción demo se sincronice. Si no existe una release oficial más nueva
   que la instalada, registra este paso como `NO EJECUTADO`, no simules una firma
   ni fuerces una OTA; la política oficial queda cubierta en native por
   `test_usb_firmware_install_policy_fails_closed` y el servicio por
   `test_usb_firmware_begin_rejects_pending_busy_and_unproved_official`.
7. Ejecuta `reboot` y repite `status` y `doctor`; la configuración y el recuento
   de pendientes deben conservarse.

La actualización oficial real, la escritura de un firmware personalizado, la
interrupción durante transferencia, la comprobación de rollback y el
restablecimiento confirmado son pruebas destructivas o de cambio de slot. Sólo
se ejecutan en una placa sacrificable, con copia restaurable y autorización
separada; no forman parte de esta lista rutinaria.

## Puesta en servicio

1. Arranca manteniendo A+B durante cinco segundos.
2. Conecta un móvil al punto de acceso `OpenJornada-XXXX` con la contraseña
   temporal mostrada en pantalla.
3. Elige uno de estos recorridos:
   1. **QR con la cámara nativa:** en otra pantalla, crea o rota la API key en
      **Integraciones → Terminales RFID**, introduce allí el SSID y la
      contraseña Wi-Fi y genera el QR efímero. Con el móvil ya conectado al AP,
      escanéalo con la aplicación de cámara del sistema; el enlace abre el portal
      local y autocompleta Wi-Fi, URL y API key.
   2. **Entrada manual:** abre `http://192.168.4.1/` y escribe directamente el
      SSID, la contraseña Wi-Fi, la URL base y la API key `ojterm_…`.
4. Revisa todos los campos y pulsa **Comprobar y guardar**. Escanear el QR sólo
   rellena el formulario: no confirma ni guarda. El firmware vuelve a validar
   los datos, responde inmediatamente con una pantalla de progreso, conecta a
   la red y comprueba `bootstrap` antes de persistirlos. Esa pantalla se
   actualiza sin reenviar el formulario y permite volver a configurarlo si la
   red o el servidor fallan.
5. Espera a que el dispositivo se reinicie.

El QR contiene credenciales recuperables y debe permanecer bajo custodia: no
lo fotografíes ni lo compartas. Integraciones lo genera sólo en el navegador,
no envía al backend ni guarda en el almacenamiento del navegador los datos
Wi-Fi o el QR, y deja de mostrarlos al cerrar la vista. Eso no equivale a
borrado criptográfico de la RAM ni hace caducar la key, que sigue activa hasta
rotarla o revocarla. Después de pulsar **Comprobar y guardar**, el firmware sí
persiste localmente la configuración validada. Si el QR ya no está disponible,
rota la key o utiliza la entrada manual.

El punto de acceso y el portal permanecen disponibles hasta guardar una
configuración válida o cancelar manteniendo C durante tres segundos. Al
cancelar, el terminal reinicia con la configuración anterior. Si no se pulsa
ningún botón durante diez minutos, sólo se apaga la pantalla: el portal sigue
funcionando. Pulsa brevemente A, B o C para despertarla.

El servidor local reconoce las comprobaciones de portal cautivo de Android,
iOS, Windows y navegadores Chromium. Las solicitudes HTTP parciales tienen un
plazo corto de inactividad para que una pestaña abandonada no bloquee el resto
del portal; la conexión Wi-Fi conserva su límite independiente de 20 segundos.

Para pruebas LAN, usa `m5stack_dev`, una IP RFC1918 del ordenador —nunca
`127.0.0.1`— y activa de forma explícita en el backend tanto
`PB_DEMO_ENABLED=true` como `PB_TERMINAL_DEV_INSECURE_HTTP=true`.
El perfil `m5stack_release` exige una URL HTTPS y no admite esta excepción.

La placa de desarrollo guarda Wi-Fi, API key, caché y cola sin cifrado. Debe
permanecer bajo control físico. Fuera del aprovisionamiento, la pantalla y los
logs no muestran API keys, contraseñas ni UIDs. Durante el aprovisionamiento,
la pantalla muestra la contraseña temporal del AP y los ojos del portal pueden
revelar la contraseña Wi-Fi o la API key; protege la placa, el móvil y cualquier
otra pantalla frente a observadores.

## Telemetría y comprobación silenciosa

Con Wi-Fi disponible, el firmware intenta cada 15 segundos
`POST /api/openjornada/terminal/v1/heartbeat`. Envía `protocolVersion`,
`clientVersion`, `cacheRevision`, `pendingCount`, `wifiRssiDbm`,
`uptimeSeconds`, `clockStatus` y, cuando existe, `lastNtpSyncAt`. La respuesta
puede traer un `pingChallenge`; en ese caso se contesta mediante
`POST /api/openjornada/terminal/v1/ping-ack` con el reto, la IP local, señal
Wi-Fi y uptime.

El mismo heartbeat incluye `firmwareUpdateStatus`, `firmwareTargetVersion`,
`lastFirmwareCheckAt` y un `firmwareUpdateErrorCode` acotado. No envía detalles
internos, URLs ni material criptográfico.

El heartbeat y su posible acuse usan un worker de telemetría aislado y de una
sola ranura. Se planifican sólo cuando el worker principal está libre, no
acumulan ciclos y nunca ocupan el trabajo activo de fichaje, sincronización,
caché o administración. El ping es silencioso: no modifica la pantalla, el
sonido, el lector ni el estado de jornada. Un fallo se descarta hasta el
siguiente ciclo.

Ningún heartbeat o acuse se añade al journal, al outbox ni a LittleFS. Las IP
no se guardan en el dispositivo ni se imprimen en logs; sólo existen durante
la petición de comprobación en curso.

## Uso y recuperación

- Acerca un tag y usa A/B/C según las etiquetas inferiores.
- Al terminar una pausa o una jornada, el terminal abre siempre el selector de
  hora con el instante de lectura del tag como valor inicial. A y C ajustan en
  intervalos de cinco minutos y B confirma la hora aplicada.
- Si se termina la jornada con una pausa abierta, primero se confirma la hora
  de fin de la pausa y, tras aceptar el cierre, un segundo selector confirma la
  hora de fin de jornada sin tener que volver a acercar la tarjeta.
- Tras diez minutos sin botones ni lecturas RFID se apaga sólo la pantalla.
  Wi-Fi, lector y sincronización continúan activos. El primer botón únicamente
  despierta la pantalla y debe soltarse antes de ejecutar otra acción; un tag
  despierta la pantalla y procesa el fichaje en la misma lectura.
- A+C durante tres segundos abre el PIN de administración; la misma pulsación
  mantenida sale explícitamente del modo administrativo. Las pantallas de
  asignación muestran este gesto para que la salida sea visible, y funciona
  incluso mientras hay una petición administrativa en curso. El plazo empieza
  en la pantalla del PIN y cada botón o lectura RFID lo reinicia. Tras cinco
  minutos sin actividad, el terminal borra la capacidad de su memoria y vuelve
  directamente a **Acerca tu tarjeta**; el servidor también caduca la capacidad
  de forma independiente. La sesión sólo funciona con red y nunca se persiste.
- A+B durante cinco segundos reabre la configuración desde cualquier pantalla,
  incluso si el terminal está esperando a la red o al servidor. Una cuenta
  atrás permite cancelar soltando los botones. Conserva la URL, la API key, la
  caché y los fichajes pendientes; en el portal basta con indicar la nueva
  Wi-Fi y dejar vacíos los secretos que no cambien.
- A+B+C durante diez segundos, soltar y mantener sólo C cinco segundos ejecuta
  el restablecimiento completo tras mostrar el número de pendientes. Es la
  única operación iniciada sólo con botones que elimina configuración, caché y
  cola; `factory-reset` USB exige la misma confirmación final con C.

Tras cada reinicio se exige una sincronización NTP nueva antes de crear
fichajes offline. La confianza caduca a las 24 horas. Los registros ya
pendientes siempre pueden sincronizarse y se envían cronológicamente con el
mismo `clientRequestId` hasta recibir un resultado definitivo.
Si NTP no responde pero la API sí, el fichaje online continúa usando una hora
anclada al `serverTime` del `bootstrap`; esa referencia no habilita fichajes
offline ni se confunde con una sincronización NTP del arranque.
Un error de lectura, conteo o replay del journal bloquea el terminal con una
pantalla fatal y un recuento conservador; nunca se acepta otra acción sobre un
estado parcial u obsoleto.
El servidor admite 500 elementos por petición; el ESP32 usa sublotes de 10 para
reservar memoria suficiente para TLS y Wi-Fi. Al instalar esta versión se
descarta una caché local de formato anterior y se reconstruye desde el servidor,
sin eliminar la cola durable.

## Diagnóstico físico

Ejecuta `scripts/hardware-smoke.sh /dev/ttyACM0`. Comprueba en pantalla que
RFID2 está disponible, pulsa A/B/C, verifica el sonido y presenta un tag dos
veces separadas por al menos 300 ms fuera del campo. Mantener el tag sobre el
lector no debe producir lecturas duplicadas.
