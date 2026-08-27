# Diseño de telemetría y ping para terminales RFID

**Fecha:** 2026-08-27
**Estado:** aprobado en conversación; pendiente de revisión documental
**Componentes:** PocketBase, Angular y firmware M5Stack RFID

## Objetivo

Permitir que una persona administradora o responsable compruebe desde el
bloque de terminales si cada M5Stack está operativo, cuándo contactó y
sincronizó por última vez, y qué estado básico tiene. También podrá solicitar
una comprobación silenciosa en tiempo real y ver temporalmente las direcciones
IP observadas durante esa comprobación.

La solución debe respetar tres límites:

- el terminal inicia todas las conexiones; el servidor no abre conexiones
  entrantes hacia la red del negocio;
- la telemetría nunca retrasa un fichaje ni su sincronización;
- las direcciones IP no se guardan en PocketBase, almacenamiento del navegador
  ni logs de aplicación.

## Alcance

Esta entrega incluye:

- heartbeat autenticado del terminal cada 15 segundos cuando el worker de red
  está libre;
- estado derivado `En línea`, `Sin conexión` o `Revocado`;
- telemetría persistente no sensible en las tarjetas de Integraciones;
- actualización automática de la lista cada 30 segundos;
- ping iniciado por `admin` o `manager`, con una espera máxima de 20 segundos;
- respuesta silenciosa del firmware sin cambiar la pantalla ni emitir sonido;
- presentación temporal de IP local, IP pública y tiempos de respuesta;
- pruebas de backend, frontend, firmware y recorrido de usuario;
- actualización de la documentación funcional y del firmware.

Quedan fuera:

- WebSockets, MQTT o conexiones permanentes;
- historial, gráficas o alertas de disponibilidad;
- geolocalización o inventario de redes;
- almacenamiento histórico de IP;
- acciones remotas como reiniciar, actualizar o hacer sonar el terminal;
- coordinación del ping entre varias réplicas del backend. La arquitectura
  actual ejecuta un único contenedor PocketBase.

## Decisiones de arquitectura

### Comunicación iniciada por el terminal

El firmware realizará `POST /api/openjornada/terminal/v1/heartbeat` cada 15
segundos mientras tenga Wi-Fi y el worker de red no esté atendiendo trabajo
prioritario. La petición usa la API key existente y no se guarda en la cola
offline: si falla, se descarta y se intenta de nuevo en el siguiente ciclo.

El heartbeat evita incorporar un canal servidor-dispositivo nuevo. Su
respuesta puede incluir un reto de ping pendiente. Cuando lo recibe, el
terminal envía inmediatamente un acuse autenticado; esta operación continúa
siendo silenciosa y queda por debajo de los fichajes y la sincronización en la
prioridad del worker.

### Coordinador de ping en memoria

El backend mantiene un coordinador en memoria indexado por ID de terminal. Al
recibir un ping administrativo:

1. comprueba usuario, empresa y estado del terminal;
2. reserva un único ping activo para ese terminal y genera un reto aleatorio
   de al menos 128 bits;
3. espera hasta que un heartbeat recoja el reto;
4. recibe el acuse autenticado del mismo terminal;
5. entrega el resultado a la petición administrativa y destruye el estado
   temporal.

El coordinador nunca se persiste. Un reinicio del backend cancela las
comprobaciones en curso. Esta elección es adecuada para el contenedor único
actual; una futura ejecución con varias réplicas necesitaría un coordinador
compartido y queda fuera de este diseño.

## API del dispositivo

### `POST /api/openjornada/terminal/v1/heartbeat`

Requiere la API key de un terminal activo. El cuerpo informa:

- `protocolVersion` y `clientVersion`;
- `cacheRevision`;
- `pendingCount`;
- `wifiRssiDbm`;
- `uptimeSeconds` desde el último arranque;
- `clockStatus`: `synced`, `stale` o `unsynced`;
- `lastNtpSyncAt`, si el reloj llegó a sincronizarse.

El servidor valida tipos, límites y fechas antes de actualizar el terminal.
Usa su propia hora para `lastHeartbeatAt`; nunca confía en el reloj del
dispositivo para decidir si está en línea.

La respuesta conserva el sobre v1 existente y contiene la hora del servidor y
un `pingChallenge` opcional. El reto solo se entrega al terminal al que
pertenece y puede entregarse más de una vez hasta recibir el acuse o expirar.
La primera entrega fija el inicio de `responseMs`; las entregas repetidas no
reinician esa medición.

### `POST /api/openjornada/terminal/v1/ping-ack`

Requiere la misma API key. El cuerpo contiene:

- el `pingChallenge` recibido;
- `localIp`, correspondiente a la interfaz Wi-Fi activa;
- `wifiRssiDbm`;
- `uptimeSeconds`.

El backend solo acepta el reto si sigue pendiente y pertenece al terminal
autenticado. La IP local se valida como una dirección IPv4 o IPv6, con un
límite estricto de longitud. El acuse no se reintenta de forma durable ni se
añade a la cola de fichajes.

El backend obtiene la IP pública observada de la dirección cliente resuelta
por PocketBase y la configuración de proxy de confianza existente; no confía
directamente en una cabecera reenviada sin validar. En redes con NAT, esta IP
puede ser la dirección de salida compartida del negocio.

Ninguna IP se escribe en colecciones, mensajes de auditoría o logs de
aplicación. Los errores no incluyen el cuerpo recibido ni la dirección
cliente.

## API administrativa

### `POST /api/openjornada/terminals/{id}/ping`

Requiere una sesión PocketBase de un usuario `admin` o `manager` de la misma
empresa que el terminal. La petición permanece abierta como máximo 20
segundos.

Una respuesta correcta contiene únicamente datos de la comprobación actual:

- `terminalId`;
- `localIp`;
- `publicIp`;
- `wifiRssiDbm`;
- `uptimeSeconds`;
- `waitForHeartbeatMs`, desde el clic hasta que el terminal recoge el reto;
- `responseMs`, desde la entrega del reto hasta el acuse;
- `totalLatencyMs`, suma de las dos fases;
- `checkedAt`, hora del servidor.

Los resultados posibles son:

- `200`: el terminal respondió;
- `403`: el usuario autenticado no tiene un rol permitido;
- `404`: el terminal no existe o pertenece a otra empresa;
- `409 terminal_revoked`: el terminal está revocado;
- `409 ping_in_progress`: ya hay una comprobación activa para ese terminal;
- `504 terminal_ping_timeout`: no hubo respuesta en 20 segundos.

Si el terminal se revoca mientras hay una comprobación pendiente, el
coordinador la cancela y no acepta un acuse posterior. El botón también queda
deshabilitado para terminales ya revocados.

## Datos persistentes

Una migración nueva amplía `attendance_terminals` con:

- `lastHeartbeatAt`: hora del servidor del último heartbeat válido;
- `lastAttendanceSyncAt`: hora del servidor de la última petición `/sync`
  procesada correctamente;
- `lastClockStatus`: último estado NTP comunicado;
- `lastNtpSyncAt`: última fecha NTP válida comunicada por el dispositivo;
- `lastWifiRssiDbm`: última intensidad Wi-Fi válida;
- `lastUptimeSeconds`: uptime comunicado en el último heartbeat.

Se reutilizan `clientVersion`, `protocolVersion`, `cacheRevision`,
`lastPendingCount`, `lastSeenAt` y `revokedAt`. `lastSeenAt` sigue indicando el
último uso autenticado genérico; `lastHeartbeatAt` tiene la semántica precisa
necesaria para calcular disponibilidad.

`lastAttendanceSyncAt` solo cambia después de que `/sync` haya validado y
producido una respuesta completa, incluso cuando el lote válido está vacío.
Un error parcial o de transporte no adelanta esa marca.

No se crea un campo `online`: la API administrativa lo deriva al leer. Un
terminal activo está en línea cuando su último heartbeat válido tiene menos
de 45 segundos. A partir de 45 segundos aparece sin conexión. `Revocado`
prevalece sobre cualquier heartbeat reciente.

No se añade ningún campo para IP local o pública.

## Prioridades y comportamiento del firmware

El worker de red conserva una única ejecución serializada. El orden de
prioridad es:

1. acciones de fichaje y confirmaciones solicitadas por la persona;
2. sincronización de la cola pendiente;
3. operaciones administrativas locales y actualización necesaria de caché;
4. heartbeat y acuse de ping.

El temporizador de 15 segundos indica que un heartbeat está disponible, pero
no interrumpe un trabajo superior ni acumula varios heartbeats. Al quedar
libre, se envía como máximo uno. El ping puede por ello agotar sus 20 segundos
si el terminal está ocupado sincronizando; el fichaje siempre gana.

Recibir o contestar un ping no modifica el estado de pantalla, no reproduce
sonido, no enciende una pantalla apagada y no altera la máquina de estados de
RFID. Un fallo de heartbeat o ping no crea una incidencia ni bloquea el uso
offline.

## Experiencia de usuario

El bloque de cada terminal en `Integraciones` muestra:

- insignia `En línea`, `Sin conexión` o `Revocado`;
- último contacto por heartbeat;
- última sincronización de fichajes;
- acciones pendientes;
- versión de firmware y protocolo;
- estado del reloj/NTP;
- señal Wi-Fi;
- tiempo encendido desde el último reinicio;
- revisión de caché.

Las fechas se muestran de forma relativa y ofrecen la fecha completa en un
texto auxiliar accesible. La señal Wi-Fi combina una descripción clara
con su valor en dBm: `Buena` desde −67 dBm, `Aceptable` entre −68 y −79 dBm y
`Débil` desde −80 dBm hacia abajo. Los campos aún no recibidos muestran `Sin
datos`, no un cero inventado.

La lista se actualiza cada 30 segundos mientras la vista está activa. El
refresco conserva los estados transitorios del ping y se detiene al abandonar
la ruta.

### Comprobar conexión

Cada terminal activo visible para `admin` o `manager` ofrece el botón
`Comprobar conexión`:

1. durante la petición muestra `Esperando respuesta…` y queda deshabilitado;
2. solo puede existir una petición simultánea por terminal;
3. al responder presenta un panel temporal con IP local, IP pública, señal
   Wi-Fi, espera hasta heartbeat, respuesta del terminal y latencia total;
4. si pasan 20 segundos muestra `El terminal no respondió` y permite
   reintentar;
5. el panel con IP desaparece 10 minutos después de recibir el resultado, al
   recargar la página o al abandonar la vista.

El resultado vive solo en una señal del componente Angular. No se escribe en
`localStorage`, `sessionStorage`, IndexedDB ni servicios de analítica. Un
refresco periódico de tarjetas no prolonga su caducidad.

Los errores de permisos, revocación y concurrencia se traducen a mensajes en
español sin exponer detalles internos.

## Seguridad y aislamiento multiempresa

- Todas las rutas reutilizan la autenticación de terminal o de usuario ya
  existente.
- El backend vuelve a comprobar organización y rol; la visibilidad del botón
  no autoriza la operación.
- Un `manager` puede consultar diagnóstico y lanzar ping, pero no obtiene
  permisos nuevos para rotar keys o revocar terminales.
- El reto aleatorio expira con el ping, se usa una sola vez y está ligado al
  ID del terminal.
- Solo hay un ping activo por terminal. La petición termina y libera recursos
  al responder, expirar, cancelarse o desconectarse el cliente.
- Un terminal revocado no puede enviar heartbeats ni acuses válidos.
- Las IP son datos efímeros de diagnóstico: no se persisten, no se auditan y
  no se registran.

## Manejo de errores

- Heartbeat inválido: `400` con código estable; no actualiza telemetría.
- API key ausente, inválida o revocada: respuesta de autenticación existente;
  no revela si el terminal existe.
- Acuse tardío, duplicado o con reto desconocido: se descarta con un error
  estable y sin modificar ningún ping nuevo.
- Terminal sin conexión: la UI conserva la última telemetría conocida y deja
  claro cuándo fue observada.
- Reinicio del backend durante un ping: la petición termina sin datos; el
  frontend lo presenta como comprobación fallida y permite reintentar.
- Pérdida de Wi-Fi: el firmware omite heartbeats, mantiene cola y caché, y
  reanuda el ciclo al recuperar conectividad.

## Pruebas

### Backend

- autenticación del heartbeat y rechazo de terminal revocado;
- validación y persistencia exclusiva de telemetría no sensible;
- actualización de `lastAttendanceSyncAt` solo tras `/sync` correcto;
- cálculo de `online` con los límites de 44, 45 y más segundos;
- aislamiento entre empresas y permisos de `admin` y `manager`;
- un único ping simultáneo por terminal;
- reto ligado al terminal, de un solo uso, duplicado y expirado;
- cancelación al revocar o desconectar la petición administrativa;
- timeout de 20 segundos;
- respuesta transitoria con IP sin campos de IP en el esquema persistente.

### Firmware

- planificación cada 15 segundos sin acumulación;
- prioridad de acciones y sincronización sobre heartbeat/ping;
- serialización y validación de heartbeat;
- acuse correcto del reto;
- ningún cambio de pantalla, sonido o estado por el ping;
- fallo de red sin entrada en el journal;
- compilación `native`, `m5stack_dev` y `m5stack_release`.

### Frontend y E2E

- presentación de estados, valores ausentes y fechas;
- refresco cada 30 segundos y cancelación al destruir el componente;
- estado de espera, éxito, timeout, revocación y ping concurrente;
- acceso de admin y responsable dentro de su empresa;
- eliminación del resultado e IP a los 10 minutos y al salir de la vista;
- recorrido completo con un terminal simulado que responde al reto.

Además deben pasar la compilación Angular, las pruebas unitarias, los E2E
afectados, las pruebas Go y las compilaciones del firmware exigidas por el
repositorio.

## Documentación

El cambio actualizará:

- `docs/FEATURES.md`, para reflejar diagnóstico y ping silencioso;
- `firmware/terminal/README.md`, con frecuencia, prioridad y datos del
  heartbeat;
- `web/README.md`, con el flujo de diagnóstico en Integraciones;
- la documentación del contrato v1 si existe una referencia separada de API.

No cambian las variables de entorno, Docker, el proceso de despliegue ni los
controles legales de jornada.

## Criterios de aceptación

La entrega se considera completa cuando:

1. un terminal conectado cambia a `En línea` en un máximo aproximado de 15
   segundos y pasa a `Sin conexión` tras 45 segundos sin heartbeat;
2. su tarjeta muestra la telemetría acordada sin almacenar IP;
3. admin y responsable pueden lanzar un ping silencioso y recibir el resultado
   dentro de 20 segundos cuando el terminal está disponible;
4. las IP solo existen en la respuesta de ese ping y desaparecen de la UI en
   las condiciones definidas;
5. un ping nunca retrasa ni bloquea un fichaje, una pausa, un cierre o la
   sincronización pendiente;
6. una terminal revocada no puede aparecer en línea ni responder;
7. las pruebas automáticas y compilaciones afectadas finalizan correctamente.
