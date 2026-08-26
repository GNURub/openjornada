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
uv tool run --from platformio platformio test -e native
uv tool run --from platformio platformio run -e m5stack_dev
uv tool run --from platformio platformio run -e m5stack_dev --target upload --upload-port /dev/ttyACM0
uv tool run --from platformio platformio device monitor --port /dev/ttyACM0 --baud 115200
uv tool run --from platformio platformio run -e m5stack_release
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
HTTPS y valida la cadena del servidor con el bundle de CA del ESP32. La
actualización v1 es exclusivamente por USB; no hay OTA.

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
   los datos, conecta a la red y comprueba `bootstrap` antes de persistirlos.
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

## Uso y recuperación

- Acerca un tag y usa A/B/C según las etiquetas inferiores.
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
  única operación local que elimina la cola.

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
