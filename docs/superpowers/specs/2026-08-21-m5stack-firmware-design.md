# Diseño del firmware M5Stack RFID v1

**Fecha:** 2026-08-21
**Estado:** aprobado en conversación; pendiente de revisión documental
**Hardware:** M5Stack Basic Core v2.7 (K001-V27) y Unit RFID2 (U031-B)
**Contrato servidor:** `/api/openjornada/terminal/v1`

## Objetivo

Crear el firmware físico del terminal RFID de OpenJornada para que una
persona pueda identificarse con su tag, iniciar o terminar su jornada y
gestionar pausas mediante los tres botones del M5Stack. El dispositivo debe
seguir siendo útil durante cortes de red, conservar las acciones pendientes y
sincronizarlas sin duplicar eventos cuando recupere la conexión.

El firmware implementa el contrato v1 ya estabilizado por la API y reproduce
la máquina de estados del simulador web. PocketBase continúa siendo la
autoridad sobre organización, persona, secuencia laboral, hora efectiva e
integridad de los eventos.

## Alcance

La primera versión incluye:

- lectura del UID mediante Unit RFID2;
- interfaz 320×240 controlada con A/B/C;
- aprovisionamiento mediante portal cautivo;
- conexión Wi-Fi, NTP y consumo de la API v1;
- fichajes online y offline;
- caché de hasta 30 tags y cola de hasta 10.000 acciones;
- firma HMAC y encadenamiento de acciones offline;
- administración local mediante A+C y PIN empresarial;
- asignación y sustitución de tags con conexión;
- recuperación de configuración mediante botones;
- compilaciones separadas de desarrollo y producción;
- flasheo y actualización por USB.

Quedan fuera de v1:

- actualización OTA;
- escritura de datos en los tags;
- microSD;
- Secure Boot, flash encryption y quema de eFuses;
- cifrado de configuración o caché en esta unidad de desarrollo;
- pantalla táctil, que no existe en el Basic v2.7.

## Hardware y conexiones

El objetivo PlatformIO es `m5stack-core-esp32`, basado en ESP32 clásico
Xtensa. La pantalla, los tres botones, el altavoz y la gestión de alimentación
se controlan mediante M5Unified.

El Unit RFID2 integra un WS1850S y se conecta al puerto Grove A:

| Señal | Basic v2.7 | RFID2 |
| --- | --- | --- |
| GND | GND | cable negro |
| 5 V | 5 V | cable rojo |
| SDA | GPIO 21 | cable amarillo |
| SCL | GPIO 22 | cable blanco |

El lector utiliza I²C en la dirección `0x28`. El firmware solo lee y normaliza
el UID; no autentica ni modifica sectores del tag.

## Tecnología y estructura

El proyecto vive en `firmware/terminal/` y usa PlatformIO con Arduino
framework. El manifiesto fija las versiones de plataforma y librerías para que
una compilación futura sea reproducible. Las dependencias iniciales son
M5Unified, M5GFX, MFRC522_I2C y ArduinoJson; el portal usa `WebServer` y
`DNSServer` del framework, sin un servicio externo.

```text
firmware/terminal/
├── platformio.ini
├── partitions.csv
├── include/
├── src/
│   ├── app/
│   ├── domain/
│   ├── hardware/
│   ├── network/
│   ├── provisioning/
│   ├── storage/
│   └── ui/
└── test/
```

Responsabilidades:

- `hardware`: adaptadores de pantalla, botones, altavoz, RFID, reloj y
  almacenamiento del ESP32.
- `provisioning`: punto de acceso temporal, DNS cautivo, formulario y
  validación de configuración.
- `network`: transporte HTTP/HTTPS y modelos JSON exactos de la API v1.
- `domain`: estados, comandos, menús y decisiones sin dependencias de Arduino.
- `storage`: configuración NVS, snapshots de caché y journal offline.
- `ui`: composición de pantallas y etiquetas de A/B/C.
- `app`: coordinación de eventos y ciclo de vida.

El bucle de interacción nunca espera una petición HTTP. La tarea principal
actualiza botones, lector y pantalla; un worker de red recibe trabajos y
devuelve resultados mediante colas FreeRTOS. Solo el coordinador de aplicación
puede cambiar el estado de dominio o confirmar una acción al usuario.

## Perfiles de compilación

`platformio.ini` define como mínimo:

- `m5stack_dev`: permite el transporte local de desarrollo y habilita
  diagnóstico serie sin datos sensibles;
- `m5stack_release`: exige HTTPS, elimina diagnóstico detallado y activa las
  restricciones de producción;
- `native`: compila el dominio, serialización y journal para pruebas en el
  ordenador.

Ambas compilaciones ESP32 usan una tabla sin particiones OTA y reservan al
menos 8 MiB para LittleFS. El tamaño exacto restante se reparte entre la
aplicación, NVS y metadatos de sistema sin reducir el espacio mínimo de la
cola.

## Aprovisionamiento

Cuando falta configuración válida, el dispositivo crea un punto de acceso
WPA2 llamado `OpenJornada-XXXX`, donde `XXXX` identifica visualmente el
terminal. Genera una contraseña temporal distinta en cada apertura y muestra
SSID, contraseña y QR en la pantalla.

El portal móvil solicita:

1. red Wi-Fi y contraseña;
2. URL base de OpenJornada;
3. API key `ojterm_…` creada previamente desde Integraciones.

Los valores se mantienen como candidatos hasta que el dispositivo conecta a
la red y completa `POST /bootstrap`. Solo entonces sustituyen la configuración
activa. Un fallo devuelve al portal con un mensaje útil sin volver a imprimir
la API key.

Mantener A+B durante cinco segundos mientras arranca abre el portal sin borrar
configuración, caché ni cola. Cambiar la API key queda bloqueado mientras
existan acciones pendientes, porque esas acciones están firmadas para el
terminal actual.

El portal se cierra al completar la configuración o tras diez minutos sin
actividad. La configuración se guarda sin cifrar en NVS por decisión expresa
para esta unidad de desarrollo. La pantalla y el puerto serie nunca muestran
contraseñas o tokens después del aprovisionamiento.

## Arranque normal

El orden de arranque es determinista:

1. inicializar alimentación, pantalla, botones y serie;
2. detectar durante cinco segundos el gesto A+B;
3. montar NVS y LittleFS;
4. validar configuración, snapshots y journal;
5. inicializar RFID2 y comprobar la dirección `0x28`;
6. conectar Wi-Fi con tiempo límite;
7. sincronizar el reloj mediante NTP;
8. ejecutar `bootstrap` y verificar protocolo `1`;
9. actualizar la caché si cambió su revisión;
10. iniciar sincronización de pendientes y mostrar reposo.

Un fallo de red no impide arrancar si existe caché válida y el reloj conserva
confianza dentro de las reglas offline. Tras cualquier reinicio no se crean
nuevas acciones offline hasta obtener NTP; las acciones pendientes anteriores
se conservan siempre.

## Lectura RFID

El lector se consulta sin bloquear. Una lectura válida se normaliza a
hexadecimal mayúscula sin separadores. El mismo UID no vuelve a generar un
evento hasta que el tag desaparece del campo durante un intervalo estable.
Esto evita duplicados por mantener la tarjeta sobre el lector.

Mientras se resuelve un UID o se ejecuta una acción no se acepta otro tag. La
pantalla conserva una salida clara para lector ausente, lectura inválida, tag
desconocido o persona inactiva; nunca imprime el UID.

## Flujo online

Con red y servidor disponibles:

1. `POST /resolve` obtiene persona abreviada, estado, avisos, acciones y
   `scanContext` de diez segundos;
2. la UI muestra las acciones durante diez segundos;
3. al pulsar A/B/C, el firmware crea un `clientRequestId`, captura la hora y
   persiste primero la acción firmada en el journal;
4. envía `POST /actions` reutilizando ese ID;
5. `accepted` o `duplicate` hacen definitivo el resultado y permiten retirar
   el registro del journal;
6. un conflicto o rechazo definitivo retira el intento, muestra el estado
   autoritativo y no inventa una transición local.

Si la respuesta se pierde, el registro permanece en el journal y se envía por
`POST /sync` con el mismo `clientRequestId`. Si el servidor ya lo había
aceptado responde `duplicate`; si nunca llegó, lo procesa una sola vez. Así no
es necesario decidir de forma insegura si un timeout ocurrió antes o después
de que el servidor registrara la acción.

## Caché y estado local

La caché contiene como máximo 30 entradas con UID, ID, nombre abreviado y
estado laboral mínimo. Se almacena en dos slots LittleFS. Cada snapshot tiene
versión, longitud, revisión y CRC32. La actualización se escribe en el slot
inactivo, se valida completamente y después se cambia atómicamente el puntero
activo en NVS.

Después de una acción offline, el estado del empleado se actualiza en memoria
y en el siguiente snapshot durable. El journal sigue siendo la fuente de
recuperación si se corta la alimentación entre ambas escrituras.

## Cola offline

La cola es un journal binario append-only con registros de longitud prefijada,
versión y CRC32. Cada registro conserva:

- UID normalizado;
- comando y hora capturada;
- hora aplicada opcional;
- última sincronización NTP;
- `clientRequestId`;
- `deviceSequence` y `rebootId`;
- hash de la acción local anterior;
- firma HMAC-SHA256.

La clave HMAC se deriva de la API key con el mismo dominio
`openjornada-terminal-signing-v1` usado por el servidor. La firma ofrece
integridad, no confidencialidad.

Todas las acciones, también las online, pasan primero por este outbox durable.
La confirmación visual se produce después de sincronizar el registro en
LittleFS y de obtener respuesta definitiva o clasificarlo como pendiente por
fallo de transporte. Al llegar a 10.000 acciones o al mínimo de espacio seguro
se bloquean nuevos fichajes y se muestra `Memoria llena; conecta la red`. Nunca
se elimina una acción de resultado desconocido.

## Sincronización

Al recuperar conexión, el worker envía lotes cronológicos de hasta 500
acciones. Para cada respuesta:

- `accepted`, `duplicate` o `incident`: resultado definitivo; puede
  compactarse del journal;
- `rejected`: se conserva y se bloquea la sincronización posterior hasta
  mostrar el motivo o recibir una respuesta definitiva en un reintento;
- fallo de transporte: se conserva todo el lote y se reintenta con backoff.

La compactación crea un journal nuevo con pendientes, valida su CRC y lo
renombra atómicamente. Un corte durante compactación deja disponible el
journal anterior o el nuevo, nunca una mezcla silenciosa.

## Hora y confianza

NTP se ejecuta al conectar y después periódicamente. El firmware conserva la
última hora NTP, la hora capturada y el identificador de arranque. Una unidad
recién reiniciada sin NTP puede mostrar la caché y sincronizar registros
anteriores, pero no crear nuevos fichajes offline.

Con el dispositivo encendido, la confianza offline caduca 24 horas después de
la última sincronización. Los cambios manuales de hora solo afectan a
`appliedAt`; nunca sustituyen `deviceCapturedAt`.

## Máquina de estados y botones

La máquina base es:

```text
idle      -> clock_in    -> working
working   -> break_start -> on_break
working   -> clock_out   -> idle
on_break  -> break_end   -> working
```

Mapeo de botones:

| Estado | A | B | C |
| --- | --- | --- | --- |
| `idle` | — | Comenzar | — |
| `working` < 4 h | Pausa | — | Terminar |
| `working` ≥ 4 h | Pausa | Terminar ahora | Terminé antes |
| `on_break` | Fin pausa | — | Acabar jornada |
| selector horario | −5 min | Confirmar | +5 min |
| confirmación de cierre | No | — | Sí |

Mantener A o C en el selector acelera en pasos de 30 minutos. Si una pausa
cruza medianoche se muestra también la fecha.

Al acabar una jornada durante una pausa:

1. preguntar `¿A qué hora terminaste la pausa?`;
2. persistir/enviar `break_end`;
3. preguntar `¿Deseas cerrar ahora la jornada?`;
4. C crea `clock_out`; A deja el estado `working`.

## Administración local

Mantener A+C durante tres segundos en reposo abre el PIN de cuatro cifras. A
resta, C suma y B confirma cada cifra. La sesión se obtiene del servidor y
caduca tras cinco minutos de inactividad.

Con sesión válida se puede recorrer la lista de hasta 30 personas, elegir una
y acercar un tag para asignarlo o sustituirlo. La asignación requiere red; no
se guarda una operación administrativa offline. Salir explícitamente cierra
la sesión en el servidor cuando sea posible y siempre elimina la capacidad de
la memoria local.

## Pantallas y feedback

Reposo muestra hora, red, contador de pendientes y `Acerca tu tarjeta`. Cada
pantalla incluye las etiquetas actuales de A/B/C en el borde inferior. Los
mensajes ordinarios desaparecen tras cinco segundos y las acciones tras diez.

Un pitido corto confirma una acción; un patrón doble indica error. El sonido
se puede desactivar en el portal. Se muestran mensajes específicos para:

- Wi-Fi o servidor no disponibles;
- reloj no fiable;
- RFID2 no detectado;
- tag no asignado;
- API key inválida o revocada;
- protocolo incompatible;
- PIN bloqueado o sesión caducada;
- cola llena;
- acción enviada a incidencia.

## Transporte local y producción

Producción acepta únicamente HTTPS y valida la cadena del certificado con un
bundle de CA incluido en el firmware.

Para pruebas en la misma red se añade al backend
`PB_TERMINAL_DEV_INSECURE_HTTP`, con valor predeterminado `false`. El backend
solo permite HTTP si esta variable y `PB_DEMO_ENABLED` son `true`, el host de
destino es privado y la dirección remota también es privada. El firmware
`m5stack_dev` aplica la misma restricción a la URL configurada. La compilación
`m5stack_release` no contiene esta excepción.

`127.0.0.1` nunca se propone al dispositivo: durante desarrollo se utiliza la
IP privada del ordenador que ejecuta OpenJornada.

## Recuperación y borrado

- A+B durante cinco segundos al arrancar: abre configuración y conserva
  datos.
- Reinicio normal: conserva configuración, caché y cola.
- Error de caché: conserva journal y exige red para reconstruir la caché.
- Error de journal: bloquea nuevos fichajes y muestra diagnóstico; no lo
  elimina automáticamente.
- Restablecimiento completo: requiere A+B+C durante diez segundos, una
  pantalla de advertencia y mantener C otros cinco segundos.

El restablecimiento completo se rechaza mientras haya pendientes, salvo una
segunda confirmación explícita que avisa de pérdida irreversible. Esta es la
única operación local capaz de borrar la cola.

## Pruebas

### Automatizadas en host

- transiciones y acciones visibles;
- umbrales de cuatro horas y pausa de 25 minutos;
- selector horario y cruce de medianoche;
- debounce y retirada de tags;
- validación de URLs por perfil;
- serialización, CRC, recuperación y compactación del journal;
- doble snapshot de caché;
- canonicalización y vectores HMAC compartidos con Go;
- mapeo de respuestas y errores de la API;
- gestos de administración, recuperación y reset;
- reintentos e idempotencia tras respuestas perdidas.

### Integración y hardware

- compilación `m5stack_dev` y `m5stack_release` en CI;
- diagnóstico de pantalla, botones, altavoz, LittleFS e I²C `0x28`;
- lectura real de varios tags y ausencia de duplicados al mantenerlos;
- portal cautivo desde móvil;
- contrato completo contra la API local;
- pérdida de Wi-Fi, reinicio, cola, reconexión e incidencia;
- asignación de tag mediante PIN;
- flasheo y monitor serie por `/dev/ttyACM0` en la placa de desarrollo.

## Entrega por etapas

1. Proyecto PlatformIO, dominio y pruebas nativas.
2. Diagnóstico de hardware flasheado en la placa real.
3. Portal cautivo, persistencia de configuración y bootstrap.
4. lectura RFID y fichajes online.
5. caché, journal, HMAC y sincronización offline.
6. administración local y asignación de tags.
7. endurecimiento, pruebas completas y documentación operativa.

Cada etapa debe mantener compilaciones host/ESP32 verdes. Las etapas de
hardware terminan con una comprobación visible en el dispositivo antes de
continuar.

## Criterios de aceptación

- Una placa nueva puede configurarse desde un móvil sin recompilar.
- A+B recupera la configuración sin perder acciones.
- El RFID2 identifica un tag una sola vez hasta retirarlo.
- Todos los flujos online del simulador funcionan en el M5Stack.
- Una acción offline se confirma solo después de persistirse.
- Un corte de alimentación no pierde ni duplica una acción confirmada.
- La cola se sincroniza idempotentemente y conserva las incidencias.
- Sin NTP fiable tras reinicio no se aceptan fichajes offline nuevos.
- La administración local no funciona offline ni fuera de su sesión.
- Desarrollo permite HTTP privado solo con doble activación explícita.
- Producción rechaza HTTP y valida HTTPS.
- Ningún log contiene API keys, contraseñas o UIDs.
- El firmware se compila, flashea y monitoriza por USB sin microSD.
