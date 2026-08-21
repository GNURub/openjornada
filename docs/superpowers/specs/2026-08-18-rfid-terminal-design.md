# Diseño del terminal RFID v1

**Fecha:** 2026-08-18
**Estado:** aprobado
**Producto:** OpenJornada para España

## Objetivo

Permitir que el personal fiche con tags RFID desde uno o varios terminales
M5Stack Core v2.7 con lector RFID2, manteniendo al servidor como autoridad,
conservando la integridad de `work_events` y soportando cortes de red sin
inventar ni perder fichajes.

La primera entrega incluye API, administración web y un simulador visual. El
firmware físico y OTA quedan fuera hasta estabilizar el contrato v1.

## Decisiones de producto

- La identificación cotidiana usa solo el UID del tag, sin PIN del empleado.
- Se acepta que UID-only es clonable y no equivale a identidad fuerte.
- No se escribe información en la memoria del tag.
- Cada empleado puede tener un único tag activo.
- Sustituir un tag revoca atómicamente el anterior.
- La asignación activa se guarda en campos protegidos de `users`; no se crea
  un historial específico de altas, sustituciones o revocaciones RFID.
- Se admiten varios terminales y una persona puede fichar desde cualquiera.
- Cada terminal usa una API key propia, sin caducidad y con rotación o
  revocación manual.
- El PIN de administración tiene cuatro cifras, es común a la empresa y se
  cambia desde la web.
- API key + sesión de PIN autorizan listar empleados y gestionar tags.
- La sesión administrativa termina manualmente o tras cinco minutos de
  inactividad.
- Se permiten hasta 30 empleados activos por terminal.

## Arquitectura

El dispositivo nunca accede directamente a las colecciones de PocketBase.
Consume una API de comandos versionada en `/api/openjornada/terminal/v1`.

La validación de secuencias, horas, ajustes, idempotencia, integridad y
auditoría se extrae de `main.pb.js` a una función de dominio compartida. La
SPA existente y la API del terminal pasan por las mismas invariantes.

Los componentes son:

1. Colecciones PocketBase para terminales, sesiones, recibos e incidencias.
2. Rutas administrativas autenticadas con el usuario de la SPA.
3. Rutas de dispositivo autenticadas con una API key del terminal.
4. Simulador Angular disponible solo en desarrollo.
5. Firmware físico definido en
   `2026-08-21-m5stack-firmware-design.md`, con caché y cola en LittleFS.

## Modelo de datos

### `attendance_terminals`

Registra empresa, nombre, prefijo y hash de API key, material de firma cifrado,
estado revocado, versión de cliente, revisión de caché, última conexión,
último contador de pendientes y marcas de tiempo.

La API key se muestra una sola vez. El servidor conserva un hash para
autenticación y el material estrictamente necesario, cifrado con
`PB_ENCRYPTION_KEY`, para verificar HMAC de la cola offline.

### `users`

Se añaden `rfidUidFingerprint` y `rfidUidCiphertext`, ambos ocultos para la API
de colección. La huella permite resolver un UID y el valor cifrado permite
construir la caché de un terminal sin guardar el UID en claro.

Una restricción única impide asignar la misma huella a dos empleados. El
servidor también valida que el empleado esté activo y pertenezca a la empresa.

### `organizations`

Se añade un hash protegido del PIN empresarial y una revisión de la caché
RFID. Cambiar el PIN invalida las sesiones administrativas abiertas y reinicia
los contadores de fallo.

### Sesiones, recibos e incidencias

- `terminal_admin_sessions` conserva capacidades opacas y su último uso.
- `terminal_action_receipts` hace idempotente cada comando por terminal.
- `terminal_sync_incidents` conserva acciones offline que no pueden encajar
  en la secuencia autoritativa y su resolución.
- `terminal_pin_attempts` aplica el bloqueo progresivo por terminal y empresa.

### `work_events`

Se amplía `source` con `terminal` y se añaden la relación al terminal, hora
capturada por el dispositivo, última sincronización NTP, secuencia local y
marca offline.

- `occurredAt`: hora efectiva del fichaje.
- `recordedAt`: hora de recepción del servidor.
- `deviceCapturedAt`: hora que capturó el terminal.
- `adjustmentSeconds`: diferencia elegida conscientemente por la persona, no
  el retraso causado por la cola offline.

## Autenticación y seguridad

- Las keys usan entropía criptográfica y formato
  `ojterm_<prefix>_<secret>`.
- La key viaja como `Authorization: Bearer ojterm_<prefix>_<secret>`.
- La capacidad administrativa viaja separada en
  `X-Terminal-Admin-Session`; nunca sustituye la autenticación del terminal.
- Las rutas de dispositivo requieren HTTPS salvo localhost y el modo privado
  de desarrollo definido en `2026-08-21-m5stack-firmware-design.md`.
- El PIN nunca se devuelve ni se descarga al terminal; el servidor compara su
  hash.
- Los intentos 1 y 2 son inmediatos. Tras el tercero se esperan 3 minutos y
  cada fallo posterior suma 3 minutos hasta un máximo de 30.
- El rate limit se aplica por terminal y de forma agregada por empresa.
- Un acierto o cambio de PIN reinicia los contadores.
- Los UIDs no aparecen en logs, mensajes de error ni respuestas de la SPA.
- Una API key revocada no puede fichar ni sincronizar acciones pendientes.
- La UI advierte antes de revocar o rotar si el último estado conocido indica
  una cola pendiente.

## API administrativa

Rutas autenticadas con PocketBase:

- `GET /api/openjornada/terminals`
- `POST /api/openjornada/terminals`
- `PATCH /api/openjornada/terminals/{id}`
- `POST /api/openjornada/terminals/{id}/rotate-key`
- `POST /api/openjornada/terminals/{id}/revoke`
- `PUT /api/openjornada/terminals/admin-pin`
- `PUT /api/openjornada/employees/{id}/rfid`
- `DELETE /api/openjornada/employees/{id}/rfid`
- `GET /api/openjornada/terminal-incidents`
- `POST /api/openjornada/terminal-incidents/{id}/resolve`

Solo `admin` gestiona terminales, keys y PIN. `admin` y `manager` pueden
gestionar asignaciones RFID e incidencias de su empresa.

## API del dispositivo

### Bootstrap

`POST /api/openjornada/terminal/v1/bootstrap` devuelve hora del servidor,
zona horaria, versiones mínima y máxima del protocolo, revisión de caché,
límite offline de 24 horas, límite de 10.000 acciones y estado del terminal.

### Administración local

- `POST /admin-sessions` valida el PIN.
- `DELETE /admin-sessions/current` cierra la sesión.
- `GET /employees` requiere sesión administrativa.
- `PUT/DELETE /employees/{id}/rfid` requieren sesión administrativa.

### Fichaje

- `POST /resolve` recibe el UID y devuelve nombre abreviado, estado actual,
  avisos, acciones permitidas y un contexto opaco válido diez segundos.
- `POST /actions` recibe contexto, comando, ID idempotente, hora capturada,
  evidencia NTP y hora aplicada opcional.
- `GET /cache?revision=...` actualiza la caché offline mínima.
- `POST /sync` recibe acciones firmadas y devuelve por elemento `accepted`,
  `duplicate`, `incident` o `rejected`.

Los comandos v1 son `clock_in`, `break_start`, `break_end` y `clock_out`.
Un conflicto devuelve `409 state_conflict` junto al estado autoritativo.

Las acciones offline incluyen `uid`, `deviceSequence`, `previousLocalHash` y
`signature`. El UID solo existe en el transporte del dispositivo —HTTPS salvo
el modo privado de desarrollo— y en el almacenamiento local del firmware; los
filtros, recibos, incidencias y logs utilizan referencias o huellas. La
primera placa de desarrollo no cifra ese almacenamiento por la decisión
documentada en el diseño del firmware.

## Máquina de estados

```text
idle      -> clock_in    -> working
working   -> break_start -> on_break
working   -> clock_out   -> idle
on_break  -> break_end   -> working
```

No se inventan transiciones. La API vuelve a comprobar el estado al ejecutar
la acción aunque el contexto de escaneo siga vigente.

Una pausa de más de 25 minutos destaca la recuperación. Una jornada abierta
de al menos 4 horas destaca `Ya terminé antes`, sin ocultar las acciones
normales.

Los cierres tardíos se aplican inmediatamente con el motivo fijo
`Olvido de cierre corregido desde terminal RFID`. Se conservan la hora
capturada y la aplicada.

## UX del M5Stack

- Reposo: hora, red, sincronización y `Acerca tu tarjeta`.
- A+C durante tres segundos abre administración.
- PIN: A resta, C suma y B confirma cada dígito.
- Tag desconocido: aviso genérico durante cinco segundos.
- Tag conocido: nombre e inicial y acciones durante diez segundos.
- `idle`: B inicia jornada.
- `working` menor de 4 h: A pausa y C termina ahora.
- `working` de al menos 4 h: A pausa, B termina ahora y C permite indicar que
  terminó antes.
- `on_break`: A termina pausa y C acaba jornada; C se destaca tras 25 minutos.
- Selector horario: A resta 5 minutos, B confirma y C suma 5; mantener A/C
  acelera.

Al acabar jornada durante una pausa:

1. Pregunta `¿A qué hora terminaste la pausa?`.
2. Confirma un `break_end` idempotente.
3. Pregunta `¿Deseas cerrar ahora la jornada?`.
4. Sí crea `clock_out`; No deja el estado `working`.

Si la pausa cruza medianoche, el selector muestra también la fecha.

## Offline y recuperación

- LittleFS en la flash interna conserva caché y cola; no se requiere microSD.
- La primera placa se trata como unidad de desarrollo y no cifra la
  configuración local. El endurecimiento físico queda para producción.
- Las acciones se encadenan y firman con HMAC-SHA256.
- No se elimina una acción hasta recibir un estado definitivo.
- La capacidad máxima es 10.000 acciones; al llenarse se bloquean fichajes.
- Tras reiniciar sin NTP no se aceptan nuevas acciones offline.
- Un terminal encendido puede operar offline hasta 24 horas desde el último
  NTP fiable.
- Al reconectar, la cola se ordena por hora capturada.
- Una secuencia incompatible o un UID ya revocado crea una incidencia.

Admin o manager resuelven la incidencia abriendo la jornada existente,
utilizando el flujo de corrección y cerrando después la incidencia con una
nota. No se fuerza ni descarta automáticamente un evento.

## Simulador

La ruta Angular solo de desarrollo reproduce 320×240, botones A/B/C, entrada
de UID, pérdida de red, avance temporal, reinicio, cola y respuestas del
servidor. Usa la API real y mantiene la key solo en la sesión del navegador.

## Criterios de aceptación

- Dos terminales pueden fichar a la misma persona sin saltarse la secuencia.
- Repetir un comando nunca duplica un `work_event`.
- Los cierres tardíos conservan hora capturada, aplicada y motivo.
- No se puede cruzar de empresa mediante UID, employee ID, terminal o
  incidencia.
- Rotar o revocar una key tiene efecto inmediato.
- El simulador recorre todos los estados online y offline.
- Los conflictos offline quedan visibles y resolubles.
- Sin terminales configurados, la aplicación mantiene su comportamiento
  actual.
