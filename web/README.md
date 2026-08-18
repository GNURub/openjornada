# Frontend de OpenJornada

SPA standalone construida con Angular 22, Tailwind CSS 4 y el SDK de PocketBase.
La documentación general está en [../README.md](../README.md). Para trabajar
con el frontend necesitas Node.js 26 y pnpm 11.17.0.

## Desarrollo

PocketBase debe responder en `http://127.0.0.1:8090`:

```bash
cd ..
docker compose up -d --build app

cd web
pnpm install --frozen-lockfile
pnpm start
```

Abre <http://localhost:4200>. Los cambios se recargan automáticamente.

## Comandos

```bash
pnpm run build      # compilación optimizada
pnpm run test:ci    # pruebas unitarias con Vitest
pnpm run e2e        # Playwright en escritorio, tableta y móvil
pnpm audit --prod
```

Las pruebas E2E compilan el backend Go, arrancan PocketBase y Angular con una
base temporal y cubren también el ciclo MCP. Requieren Go 1.25 o posterior y
Chromium instalado mediante:

```bash
pnpm exec playwright install chromium
```

## Organización

```text
src/app/core/       servicios, modelos, guards y cálculos
src/app/features/   módulos funcionales cargados de forma diferida
src/app/shared/     shell y navegación
e2e/                recorridos Playwright
```

La API se resuelve contra `127.0.0.1:8090` en desarrollo y contra el mismo origen
que sirve la SPA en producción.

## Integraciones MCP

La ruta protegida `/integraciones` está disponible para `admin` y `manager`.
Permite emitir tokens con caducidad de uno a seis meses, copiar el secreto una
sola vez, consultar último uso y revocar. El secreto sólo vive en la señal del
componente mientras se muestra: no se guarda en `localStorage`, PocketBase ni
la caché PWA.

La pantalla consume `GET/POST /api/openjornada/mcp-tokens` y
`POST /api/openjornada/mcp-tokens/{id}/revoke`. El protocolo remoto se publica
en `/mcp`. El ejemplo de configuración para Codex usa la URL MCP que devuelve
el servidor, derivada de `PB_PUBLIC_URL`.

## Terminales RFID y simulador

La sección **Integraciones → Terminales RFID** permite a `admin` crear, rotar y
revocar una credencial por dispositivo y configurar el PIN empresarial. Los
perfiles `admin` y `manager` consultan los terminales; sólo administración ve o
cambia secretos. En `/equipo` ambos perfiles pueden comprobar si una persona
tiene tag, asignar uno, sustituirlo o revocarlo. El UID se envía una vez y no se
vuelve a mostrar. La caché offline v1 admite hasta 30 personas activas con tag.

Los dispositivos consumen `/api/openjornada/terminal/v1`: `bootstrap`,
`resolve`, `actions`, `sync`, sesiones administrativas, caché y asignación de
tags. Un contexto firmado y efímero enlaza cada lectura online con sus acciones.
La cola sin conexión conserva la hora capturada, la secuencia y una firma HMAC;
el servidor comprueba el reloj, la asignación vigente y el estado resultante.
Los conflictos aparecen en **Control horario → Incidencias RFID**, desde donde
administración o responsables abren la trazabilidad y documentan su resolución.

`/terminal-simulator` sólo se registra con el servidor de desarrollo de Angular.
Muestra una pantalla 320 × 240, botones A/B/C, lector UID, estado de red, avance
del reloj y reinicio. Permite probar la asignación con A+C mantenidos tres
segundos, el flujo normal de jornada, la corrección de una pausa olvidada en una
jornada de al menos cuatro horas y la sincronización de acciones offline. La
clave introducida permanece únicamente en memoria y se pierde al recargar.

## Control horario

La ruta `/registros` muestra por defecto la **Hoja de fichajes** diaria o
mensual. Sus totales proceden de
`GET /api/openjornada/timesheet`, que calcula en PocketBase el tiempo trabajado,
la planificación aplicable, el balance y las horas extra. La pestaña
**Trazabilidad** conserva la consulta de eventos originales, correcciones y CSV.
También descarga un paquete JSON generado por PocketBase que incluye todos los
campos de evidencia y verifica los hashes, predecesores, raíz y punta de la
cadena completa de la persona.

El panel principal obtiene también de ese endpoint la planificación del día.
El objetivo y la barra de progreso se adaptan a sus minutos reales; cuando no
hay un tramo aplicable muestran **Sin planificación** en vez de presuponer ocho
horas. En **cómputo semanal flexible**, el panel muestra el objetivo semanal y
acumula los fichajes de lunes a domingo contra los minutos contratados.

Al terminar jornada o pausa, el modal muestra la duración y permite ajustar la
hora. Si la diferencia material supera el umbral de revisión, exige un motivo;
el servidor conserva por separado la hora de recepción, la hora aplicada, la
diferencia, el motivo y una huella v2.

La ruta `/resumenes` contiene cierres mensuales inmutables. Administración o
responsables cierran un mes ya terminado después de resolver solicitudes y
anomalías; PocketBase separa minutos ordinarios, complementarios y
extraordinarios. Cada nueva versión enlaza la anterior, se notifica a la
persona y el acuse de recepción es idempotente. Su CSV replica la persona,
periodo, versión, minutos planificados, ordinarios, complementarios,
extraordinarios y totales, la huella de integridad y el desglose de cada día.
En contratos parciales variables, el cálculo combina todos los horarios
semanales cuya vigencia intersecta el mes. Los tramos acotados siguen formando
parte del histórico aunque se archiven en la interfaz. Si la persona usa
**cómputo semanal flexible**, no necesita franjas fijas: el cierre clasifica el
exceso sobre la cuota semanal como extraordinario en tiempo completo o como
complementario en tiempo parcial con pacto. Sin pacto, el cierre bloquea sólo
cuando se supera realmente esa cuota semanal.

La ruta `/informes` permite descargar un **Excel de inspección**. El rango
predeterminado son los últimos cuatro años y puede ajustarse en la interfaz
hasta un máximo de cuatro años por archivo. Incluye una hoja resumen y una hoja
por cada cuenta con rol `employee`, aunque esté inactiva o su contrato aún no
esté clasificado. Cada hoja conserva planificación, tiempo trabajado, balance, horas
complementarias o extraordinarias según contrato, entradas, salidas, pausas,
festivos, ausencias, incidencias y huellas de integridad.

En `/ausencias`, administración dispone de **Políticas y saldos → Cupo anual
por persona**. Puede fijar un número distinto para cada persona, tipo y año,
en días completos o medios días. El cupo contractual se conserva separado del
arrastre y de los ajustes excepcionales; el servidor bloquea cambios de empresa,
persona, tipo o año y audita cada modificación. La estimación de la solicitud y
la validación de PocketBase usan el horario vigente de la persona: un sábado
planificado cuenta como vacaciones y un descanso entre semana no se descuenta.
En cómputo flexible usan los días laborables de referencia configurados en
`/equipo`, que no representan horas pactadas de entrada o salida.

La vista principal de `/ausencias` presenta el saldo disponible, el historial y
los doce meses del año en un único resumen adaptable. Las solicitudes se crean
en un modal con selector de jornada completa o media jornada y calendario para
elegir el rango. Los perfiles `admin` y `manager` conservan una sección
específica de peticiones del equipo para buscar, filtrar, consultar detalles y
resolver las que estén pendientes. La persona trabajadora puede consultar todos
los estados en su historial, abrir justificantes y cancelar una solicitud propia
mientras continúe pendiente.
Los festivos aparecen destacados en rojo tanto en el resumen anual como en el
calendario del equipo. El perfil `admin` puede crearlos, filtrarlos por año,
editarlos y eliminarlos desde **Políticas y saldos**; el servidor mantiene estas
operaciones restringidas a la organización del administrador.
En **Ajustes → Configuración de empresa**, administración puede guardar la
dirección del centro principal con selectores encadenados de comunidad autónoma,
provincia y municipio. Al completar la ubicación, la pantalla propone una
previsualización del calendario laboral aplicable y permite elegir qué fechas
importar. Las fechas existentes no se sobrescriben y cada alta conserva ámbito,
fuente y atribución a [Calendarios Nacionales](https://calendariosnacionales.com/es/api/).
Las respuestas externas se consultan desde el servidor, se validan y se mantienen
en caché durante seis horas.
El cupo inicial de **Asuntos propios** es cero. Los tipos cuyo cupo, arrastre y
ajuste suman cero no aparecen en las tarjetas ni en el selector de nuevas
solicitudes; administración sigue viéndolos en **Políticas y saldos** para poder
asignar días.

En el día actual o en uno pasado propio, **Añadir tiempo** abre un editor compacto junto al día,
con el mismo patrón de entrada rápida para elegir Trabajo o Pausa, indicar desde
qué hora hasta qué hora y marcar **Empieza el día siguiente (+1d)**. Se pueden
encadenar varios tramos sin abandonar el popover. La primera incorporación en
un día sin historial no pide motivo; las pausas necesitan un tipo activo y la
solicitud puede quedar aprobada automáticamente o pendiente según
`organization.manualTimeApprovalRequired`; mientras está pendiente el empleado
puede cancelarla y `admin`/`manager` pueden aprobarla o rechazarla. En la fecha
actual PocketBase rechaza cualquier tramo que aún no haya terminado.

Cuando el día ya contiene fichajes, la misma hoja muestra **Corregir jornada**.
El editor se precarga con los tramos efectivos y permite cambiar horas, añadir
trabajo o pausas y anular tramos. Al mover un límite compartido se actualiza el
tramo contiguo para no dejar huecos involuntarios. `POST
/api/openjornada/timesheet-corrections` conserva una instantánea del estado
original; según `organization.timeCorrectionApprovalRequired`, la sustitución
se aplica automáticamente o queda pendiente. Los fichajes anteriores nunca se
borran: PocketBase crea anulaciones lógicas trazables y materializa la secuencia
corregida. También se puede eliminar uno o todos los tramos; el editor explica
por qué está bloqueado el envío, exige un motivo de al menos ocho caracteres y
rechaza duraciones nulas, superiores a dieciséis horas o solapadas. Si una
corrección anuló todos los tramos, cualquier alta posterior en esa fecha sigue
el flujo de corrección y vuelve a exigir el motivo.

La cuenta `admin` configura ambas políticas y los tipos de pausa en
**Ajustes → Jornadas manuales, correcciones y pausas**. La interfaz sólo recoge los datos:
fechas, solapamientos, permisos, pertenencia a la empresa y materialización de
eventos se validan de nuevo en los endpoints de PocketBase.

En **Ajustes → Preservaciones legales**, `admin` puede bloquear registros de
toda la empresa o de una persona y periodo. La vista previa calcula datos
anteriores a la retención y los protegidos, pero no ejecuta ninguna eliminación.

En **Horarios → Asignar horario**, administración y responsables pueden buscar
y seleccionar varias personas. La interfaz envía una única petición a
`POST /api/openjornada/work-schedules/bulk`; PocketBase valida todas las
personas y crea un horario individual por empleado dentro de una transacción.
Si una selección no es válida, no se crea ninguna asignación parcial.
Para una distribución variable se crea un tramo con fecha de inicio y fin por
cada semana —o más de uno cuando distintos días tengan duraciones diferentes—.
Esas fechas son la planificación que después utiliza el cierre mensual; no se
debe convertir a posteriori el tiempo fichado en tiempo planificado.
Las tarjetas distinguen visualmente horarios próximos, activos, finalizados y
archivados, de modo que una ficha activa pero ya vencida no parece vigente.

En `/equipo`, administración y responsables pueden elegir **Cómputo semanal
flexible**, editar las horas semanales contratadas en intervalos de quince
minutos, el pacto de horas complementarias y los días laborables de referencia.
El servidor conserva el dato normalizado en minutos para los cálculos. El modo
tradicional de planificación con horarios sigue siendo el valor predeterminado.
La ayuda contextual del pacto recuerda que sólo debe marcarse en contratos
parciales cuando exista el correspondiente acuerdo escrito, no para justificar
automáticamente un exceso de fichaje.

## Invitaciones de acceso

En `/equipo`, administración y responsables pueden enviar o renovar una
invitación al correo de una persona. La fila muestra si está sin invitación,
pendiente, caducada o aceptada; los fallos de entrega SMTP aparecen en un toast
accesible sin ocultar el estado anterior.

El enlace abre `/invitacion/:token`, es válido durante 72 horas y sólo puede
utilizarse una vez. La persona establece una contraseña de al menos 10
caracteres y, tras la aceptación, la SPA inicia su sesión automáticamente. El
servidor conserva únicamente el hash del token y vuelve a validar empresa, rol,
correo, vigencia y estado.

## PWA

La compilación de producción registra el service worker de Angular y genera
`ngsw.json`. La aplicación se puede instalar desde un navegador compatible y
ofrece el shell estático cuando no hay conexión.

Cuando hay una jornada activa o pausada, el shell autenticado muestra un widget
flotante en móvil, tablet y escritorio. El widget conserva el estado al navegar,
muestra el tiempo efectivo acumulado con segundos y permite pausar, reanudar o
finalizar sin volver a **Mi jornada**. Un asa permite moverlo temporalmente con
ratón, pantalla táctil, lápiz o teclado; las flechas desplazan su posición y
`Inicio` la restablece. En navegadores de escritorio compatibles con Document
Picture-in-Picture aparece un control para trasladar el widget a una ventana
del sistema siempre visible. La apertura requiere un clic de la persona,
funciona en un contexto seguro (`https://` o desarrollo local) y el widget
vuelve a la aplicación al cerrar la ventana. La opción **Abrir el control en
ventana flotante al fichar** está activada inicialmente, queda guardada en el
navegador y abre PiP dentro del mismo clic usado para empezar la jornada.

La cuenta `admin` puede personalizar en **Ajustes → Configuración de empresa**
el color principal, el color secundario, el logotipo, el nombre completo y
corto de la PWA. El logotipo admite PNG, JPEG o WebP de hasta 5 MB. Al
seleccionarlo, el navegador genera automáticamente un icono PNG cuadrado de
512 × 512 px, con el logotipo centrado sobre el color secundario. Al guardar:

- se actualizan los colores, la cabecera, el título y el logotipo;
- PocketBase sirve desde el icono generado las variantes de 16, 32, 180 y
  192 px para favicon, Apple Touch Icon y manifiesto PWA;
- el manifiesto pasa a
  `/api/openjornada/branding/{organization}/manifest.json`;
- cada empresa recibe su propio nombre, color e icono al instalar la aplicación.

Antes de iniciar sesión se usa la identidad general de OpenJornada. Los
logotipos e iconos derivados son recursos públicos porque el navegador debe
poder leerlos durante la instalación; no deben contener fotografías, firmas ni
otros datos personales.

Las respuestas de PocketBase, los documentos protegidos y las rutas `/api/` y
`/_/` quedan fuera de la caché PWA. Sin conexión no se pueden consultar ni
modificar datos laborales.

Para probar la instalación localmente:

```bash
pnpm run build
pnpm dlx http-server dist/web/browser -p 4218 -c-1
```

Abre <http://localhost:4218>. El service worker no se registra con `pnpm start`
porque Angular lo desactiva en desarrollo.
