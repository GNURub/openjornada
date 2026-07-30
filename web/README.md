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

Las pruebas E2E arrancan PocketBase y Angular con una base temporal. Requieren
`../backend/bin/pocketbase` y Chromium instalado mediante:

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

## Control horario

La ruta `/registros` muestra por defecto la **Hoja de fichajes** diaria o
mensual. Sus totales proceden de
`GET /api/openjornada/timesheet`, que calcula en PocketBase el tiempo trabajado,
la planificación aplicable, el balance y las horas extra. La pestaña
**Trazabilidad** conserva la consulta de eventos originales, correcciones y CSV.

En el día actual o en uno pasado propio, **Añadir tiempo** abre un editor compacto junto al día,
con el mismo patrón de entrada rápida para elegir Trabajo o Pausa, indicar desde
qué hora hasta qué hora y marcar **Empieza el día siguiente (+1d)**. Se pueden
encadenar varios tramos sin abandonar el popover. El motivo sigue siendo
obligatorio, las pausas necesitan un tipo activo y la solicitud puede quedar
aprobada automáticamente o pendiente según
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
rechaza duraciones nulas, superiores a dieciséis horas o solapadas.

La cuenta `admin` configura ambas políticas y los tipos de pausa en
**Ajustes → Jornadas manuales, correcciones y pausas**. La interfaz sólo recoge los datos:
fechas, solapamientos, permisos, pertenencia a la empresa y materialización de
eventos se validan de nuevo en los endpoints de PocketBase.

En **Horarios → Asignar horario**, administración y responsables pueden buscar
y seleccionar varias personas. La interfaz envía una única petición a
`POST /api/openjornada/work-schedules/bulk`; PocketBase valida todas las
personas y crea un horario individual por empleado dentro de una transacción.
Si una selección no es válida, no se crea ninguna asignación parcial.

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
