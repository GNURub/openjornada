# OpenJornada

OpenJornada es una plataforma de gestión laboral y RR. HH. para pequeñas y
medianas empresas. Incluye registro horario, ausencias, gastos, documentos,
onboarding y objetivos en una SPA responsive.

La aplicación usa Angular 22, Tailwind CSS 4 y PocketBase 0.39.9. Frontend,
API, migraciones y archivos estáticos se distribuyen en un único contenedor.

## Funcionalidad

- Autenticación, recuperación de contraseña e invitaciones por correo de un solo
  uso, con 72 horas de validez, creación de contraseña y acceso automático.
- Roles `admin`, `manager`, `employee` y `representative`, aislados por empresa.
- Fichajes y pausas con hora de servidor, idempotencia, cadena SHA-256 y auditoría.
- Hoja diaria y mensual con trabajado, planificado, balance y horas extra; la
  plantilla puede completar jornadas pasadas mediante tramos de trabajo y pausas.
- Política por empresa para aplicar esas altas automáticamente o someterlas a
  aprobación, con tipos de pausa remunerados o no remunerados.
- Correcciones de jornada con aprobación y trazabilidad inmutable.
- Ausencias con tipos, saldos, festivos, medias jornadas, bloqueos, justificantes,
  calendario, asignación y aprobación.
- Gastos con categorías, recibos protegidos, revisión, aprobación y pago.
- Documentos privados o corporativos con confirmación de lectura y aviso al
  destinatario.
- Tareas de onboarding, formación y administración.
- Objetivos por ciclos y seguimiento porcentual.
- Horarios, comunicados, informes y exportaciones CSV.
- Identidad corporativa por empresa: colores, logotipo y nombre; el icono de la
  PWA y los favicons se generan automáticamente desde el logotipo.
- PWA instalable con manifiesto por empresa, iconos adaptativos y shell disponible
  sin conexión.
- SMTP opcional, límites de peticiones y cifrado de secretos de PocketBase.

La cobertura funcional detallada está en
[docs/FEATURES.md](docs/FEATURES.md).

## Inicio rápido en modo demo

Requisitos:

- Docker 26 o posterior.
- Docker Compose 2.26 o posterior.

```bash
cp .env.example .env
openssl rand -hex 16
```

Edita `.env`:

```dotenv
PB_PUBLIC_URL=http://localhost:8090
PB_ENCRYPTION_KEY=pega-aqui-los-32-caracteres-generados
PB_BOOTSTRAP_ADMIN_PASSWORD=elige-una-contrasena-segura
PB_DEMO_ENABLED=true
```

Arranca la aplicación:

```bash
docker compose up -d --build
docker compose ps
```

Abre <http://localhost:8090>. La cuenta administradora usa
`PB_BOOTSTRAP_ADMIN_EMAIL` y `PB_BOOTSTRAP_ADMIN_PASSWORD`. La cuenta de demo
usa `PB_DEMO_EMAIL` y `PB_DEMO_PASSWORD`.

Comandos habituales:

```bash
docker compose logs -f app
docker compose restart app
docker compose down
```

`docker compose down` conserva la base de datos. No uses
`docker compose down -v` salvo que quieras borrar definitivamente todos los
datos locales.

## Desarrollo local

La opción recomendada mantiene PocketBase en Docker y ejecuta Angular con
recarga automática. Para el frontend necesitas Node.js 26 y pnpm 11.17.0; la
versión de pnpm está fijada en `web/package.json`.

Terminal 1:

```bash
cp .env.example .env
# Configura PB_ENCRYPTION_KEY y las credenciales antes de continuar.
docker compose up -d --build app
```

Terminal 2:

```bash
cd web
pnpm install --frozen-lockfile
pnpm start
```

- Frontend de desarrollo: <http://localhost:4200>
- PocketBase y frontend compilado: <http://localhost:8090>
- Salud de la API: <http://localhost:8090/api/health>

Cuando el frontend se ejecuta en los puertos `4200` o `4217`, se conecta
automáticamente a PocketBase en `127.0.0.1:8090`.

Para desarrollar PocketBase sin Docker hace falta descargar el binario
0.39.9 en `backend/bin/pocketbase`. Ese directorio está ignorado por Git.

## Producción

La guía completa está en [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). El despliegue
mínimo usa el archivo dedicado de producción:

```bash
cp .env.example .env
# Completa la URL HTTPS, secretos, cuenta inicial y SMTP.
docker compose -f docker-compose.production.yml up -d --build
curl -fsS http://127.0.0.1:8090/api/health
```

En producción:

1. Mantén `PB_DEMO_ENABLED=false`.
2. Usa una `PB_ENCRYPTION_KEY` única de 32 caracteres y guárdala fuera del servidor.
3. Publica PocketBase mediante un proxy HTTPS; el compose de producción sólo
   escucha en `127.0.0.1:8090`.
4. Restringe el panel `/_/` a administradores o a una red privada.
5. Configura SMTP para verificación y recuperación de cuentas.
6. Conserva el volumen `pocketbase_data` y programa copias cifradas.
7. Revisa [docs/COMPLIANCE_ES.md](docs/COMPLIANCE_ES.md) antes de tratar datos reales.

### Imágenes Docker de release

Al publicar una Release de GitHub con una etiqueta semántica como `v1.4.2`,
GitHub Actions construye la imagen para `linux/amd64` y `linux/arm64` y la
publica en GitHub Container Registry:

```bash
docker pull ghcr.io/gnurub/openjornada:1.4.2
```

Una release estable genera las etiquetas `1.4.2`, `1.4`, `1`, `latest` y una
etiqueta inmutable basada en el commit. Una prerelease, por ejemplo
`v1.5.0-rc.1`, sólo genera su versión completa y la etiqueta del commit; nunca
actualiza `latest`. La guía de despliegue explica permisos, visibilidad y
verificación de la imagen.

### Proveedores de hosting

<p align="center">
  <a href="docs/DEPLOYMENT.md#coolify"><img src="https://img.shields.io/badge/Deploy%20on-Coolify-6B16ED?style=for-the-badge&amp;logo=coolify&amp;logoColor=white" alt="Guía de despliegue en Coolify" height="32"></a>
  <a href="docs/DEPLOYMENT.md#railway"><img src="https://railway.com/button.svg" alt="Guía de despliegue en Railway" height="32"></a>
  <a href="https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2FGNURub%2Fopenjornada"><img src="https://render.com/images/deploy-to-render-button.svg" alt="Desplegar en Render" height="32"></a>
  <a href="docs/DEPLOYMENT.md#flyio"><img src="https://img.shields.io/badge/Deploy%20on-Fly.io-7B3FF2?style=for-the-badge&amp;logo=flydotio&amp;logoColor=white" alt="Guía de despliegue en Fly.io" height="32"></a>
  <a href="docs/DEPLOYMENT.md#zeabur"><img src="https://img.shields.io/badge/Deploy%20on-Zeabur-6300FF?style=for-the-badge&amp;logo=zeabur&amp;logoColor=white" alt="Guía de despliegue en Zeabur" height="32"></a>
  <a href="docs/DEPLOYMENT.md#northflank"><img src="https://img.shields.io/badge/Deploy%20on-Northflank-111827?style=for-the-badge&amp;logo=northflank&amp;logoColor=white" alt="Guía de despliegue en Northflank" height="32"></a>
</p>

| Proveedor  | Método disponible              | Persistencia                           |
| ---------- | ------------------------------ | -------------------------------------- |
| Render     | Un clic mediante `render.yaml` | Disco de 1 GB incluido en el Blueprint |
| Coolify    | Guiado con Docker Compose      | Volumen Docker                         |
| Railway    | Guiado con Dockerfile          | Volumen del servicio                   |
| Fly.io     | Guiado con `fly.toml`          | Fly Volume                             |
| Zeabur     | Guiado desde GitHub            | Volumen del servicio                   |
| Northflank | Guiado como servicio combinado | Volumen de lectura/escritura única     |

Todas las opciones ejecutan una sola instancia y conservan `/app/pb_data`.
Consulta los [pasos por proveedor](docs/DEPLOYMENT.md#despliegue-en-proveedores-gestionados)
antes de usar datos reales.

Vercel puede ejecutar contenedores Docker, pero sus contenedores son _stateless_.
No se ofrece un botón porque PocketBase necesita conservar SQLite y los adjuntos
en `/app/pb_data`; un despliegue allí perdería datos al reemplazar o escalar una
instancia. Consulta la
[comparativa oficial de Vercel](https://vercel.com/kb/guide/docker-on-vercel-vs-render).

## Variables de entorno

| Variable                      | Obligatoria     | Uso                                                                           |
| ----------------------------- | --------------- | ----------------------------------------------------------------------------- |
| `PB_APP_NAME`                 | Sí              | Nombre mostrado en PocketBase y correos.                                      |
| `PB_PUBLIC_URL`               | Sí              | URL pública completa; HTTPS en producción.                                    |
| `PB_ENCRYPTION_KEY`           | Sí              | Clave de exactamente 32 caracteres. No debe rotarse sin un plan de migración. |
| `PB_ORGANIZATION_NAME`        | Sí              | Empresa creada durante el bootstrap inicial.                                  |
| `PB_ORGANIZATION_TAX_ID`      | Sí              | Identificador único usado para un bootstrap idempotente.                      |
| `PB_TIMEZONE`                 | Sí              | Zona IANA, por ejemplo `Europe/Madrid`.                                       |
| `PB_BOOTSTRAP_ADMIN_EMAIL`    | Sí              | Correo de la primera cuenta administradora.                                   |
| `PB_BOOTSTRAP_ADMIN_PASSWORD` | Sí              | Contraseña inicial robusta.                                                   |
| `PB_BOOTSTRAP_ADMIN_NAME`     | No              | Nombre visible de la cuenta administradora.                                   |
| `PB_MAIL_SENDER_NAME`         | No              | Nombre visible del remitente; usa `PB_APP_NAME` si se omite.                  |
| `PB_MAIL_SENDER_ADDRESS`      | No              | Dirección remitente autorizada por el proveedor SMTP.                         |
| `PB_SMTP_HOST`                | Para correo     | Host SMTP. Un valor no vacío activa el envío SMTP.                            |
| `PB_SMTP_PORT`                | Para correo     | Puerto SMTP; usa `587` si se omite. Debe coincidir con el proveedor.          |
| `PB_SMTP_USERNAME`            | Según proveedor | Usuario SMTP; puede ser una cuenta, un identificador o una clave.             |
| `PB_SMTP_PASSWORD`            | Según proveedor | Contraseña de aplicación o secreto SMTP. Nunca debe añadirse a Git.           |
| `PB_SMTP_TLS`                 | Para correo     | `true` obliga TLS; `false` intenta STARTTLS y deja la decisión al servidor.   |
| `PB_DEMO_ENABLED`             | No              | Crea una empleada de ejemplo cuando vale `true`.                              |
| `PB_DEMO_EMAIL`               | Demo            | Correo de la empleada de ejemplo.                                             |
| `PB_DEMO_PASSWORD`            | Demo            | Contraseña de la empleada de ejemplo.                                         |

Las variables de bootstrap crean registros si no existen; no sobrescriben
contraseñas ni datos ya guardados.

### Correo SMTP

SMTP es opcional para ejecutar la aplicación, pero es necesario para que las
invitaciones de acceso, la recuperación de contraseña y los avisos por correo de
ausencias, documentos, tareas y comunicaciones lleguen a los usuarios. Configura en `.env`
el remitente, el host, el puerto, las credenciales y el modo TLS indicados por tu
proveedor. Usa una contraseña de aplicación o credencial SMTP cuando el
proveedor no admita la contraseña normal de la cuenta.

PocketBase aplica estos valores al arrancar. Después de cambiarlos, recrea el
contenedor; `docker compose restart` por sí solo no relee `.env`:

```bash
docker compose up -d --force-recreate app
```

El endpoint `/api/health` sólo confirma que la API está disponible. Comprueba el
correo enviando una invitación a una cuenta de prueba desde **Tu equipo** y
verifica remitente, entrega, caducidad y URL del enlace. La configuración detallada,
incluido un ejemplo completo y las precauciones de producción, está en
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#correo-smtp).

## Pruebas y calidad

```bash
cd web
pnpm install --frozen-lockfile
pnpm run build
pnpm run test:ci
pnpm run e2e
pnpm audit --prod

cd ..
docker build -t openjornada .
docker compose -f docker-compose.production.yml config --quiet
```

Playwright crea una base temporal y no toca los datos de desarrollo o producción.
Para E2E local necesita `backend/bin/pocketbase` y los navegadores de Playwright:

```bash
cd web
pnpm exec playwright install chromium
```

## Datos, copias y actualizaciones

PocketBase guarda la base de datos y los archivos en `/app/pb_data`, respaldado
por el volumen `pocketbase_data`. No copies sólo el archivo SQLite: conserva el
directorio completo y prueba periódicamente la restauración.

Antes de actualizar:

1. Crea y verifica una copia cifrada.
2. Lee los cambios de PocketBase y de las dependencias.
3. Ejecuta todas las pruebas.
4. Prueba la actualización y la restauración fuera de producción.
5. Despliega con `docker compose ... up -d --build`.

PocketBase aún no ha alcanzado la versión 1.0; no actualices su versión fijada sin
revisar migraciones, hooks y compatibilidad del SDK.

## Estructura

```text
backend/
  pb_migrations/   esquema y reglas de acceso
  pb_hooks/        bootstrap, validación, auditoría y notificaciones
docs/
  COMPLIANCE_ES.md
  DEPLOYMENT.md
  FEATURES.md
deploy/
  docker-compose.cloud.yml
scripts/
  e2e-server.sh
web/
  e2e/             recorridos Playwright
  src/app/core/    autenticación y dominio compartido
  src/app/features módulos funcionales
fly.toml            configuración para Fly.io
railway.json        configuración para Railway
render.yaml         Blueprint de Render
AGENTS.md           guía de trabajo para agentes y contribuidores
```

## Seguridad y contribución

- No subas `.env`, bases de datos, binarios, informes de pruebas ni secretos.
- Las reglas de PocketBase y los hooks son la frontera de autorización; ocultar
  elementos en Angular no sustituye una regla de servidor.
- Las migraciones ya publicadas son inmutables. Añade otra migración para cambiar
  el esquema.
- Lee [AGENTS.md](AGENTS.md) antes de modificar el proyecto.

Este repositorio todavía no incluye un archivo `LICENSE`. Antes de distribuirlo
como software libre debe elegirse y añadirse explícitamente una licencia.
