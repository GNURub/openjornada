# OpenJornada

OpenJornada es una plataforma de gestión laboral y RR. HH. para pequeñas y
medianas empresas. Incluye registro horario, ausencias, gastos, documentos,
onboarding y objetivos en una SPA responsive.

La aplicación usa Angular 22, Tailwind CSS 4 y PocketBase 0.39.9. Frontend,
API, migraciones y archivos estáticos se distribuyen en un único contenedor.

## Funcionalidad

- Autenticación, recuperación de contraseña y verificación por correo.
- Roles `admin`, `manager`, `employee` y `representative`, aislados por empresa.
- Fichajes y pausas con hora de servidor, idempotencia, cadena SHA-256 y auditoría.
- Correcciones de jornada con aprobación y trazabilidad inmutable.
- Ausencias con tipos, saldos, festivos, medias jornadas, bloqueos, justificantes,
  calendario, asignación y aprobación.
- Gastos con categorías, recibos protegidos, revisión, aprobación y pago.
- Documentos privados o corporativos con confirmación de lectura.
- Tareas de onboarding, formación y administración.
- Objetivos por ciclos y seguimiento porcentual.
- Horarios, comunicados, informes y exportaciones CSV.
- SMTP opcional, límites de peticiones y cifrado de secretos de PocketBase.

La cobertura funcional detallada está en
[docs/FACTORIAL_FEATURES.md](docs/FACTORIAL_FEATURES.md).

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
recarga automática.

Terminal 1:

```bash
cp .env.example .env
# Configura PB_ENCRYPTION_KEY y las credenciales antes de continuar.
docker compose up -d --build app
```

Terminal 2:

```bash
cd web
npm ci
npm start
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

## Variables de entorno

| Variable | Obligatoria | Uso |
| --- | --- | --- |
| `PB_APP_NAME` | Sí | Nombre mostrado en PocketBase y correos. |
| `PB_PUBLIC_URL` | Sí | URL pública completa; HTTPS en producción. |
| `PB_ENCRYPTION_KEY` | Sí | Clave de exactamente 32 caracteres. No debe rotarse sin un plan de migración. |
| `PB_ORGANIZATION_NAME` | Sí | Empresa creada durante el bootstrap inicial. |
| `PB_ORGANIZATION_TAX_ID` | Sí | Identificador único usado para un bootstrap idempotente. |
| `PB_TIMEZONE` | Sí | Zona IANA, por ejemplo `Europe/Madrid`. |
| `PB_BOOTSTRAP_ADMIN_EMAIL` | Sí | Correo de la primera cuenta administradora. |
| `PB_BOOTSTRAP_ADMIN_PASSWORD` | Sí | Contraseña inicial robusta. |
| `PB_BOOTSTRAP_ADMIN_NAME` | No | Nombre visible de la cuenta administradora. |
| `PB_MAIL_SENDER_NAME` | No | Remitente visible de los correos. |
| `PB_MAIL_SENDER_ADDRESS` | No | Dirección remitente. |
| `PB_SMTP_*` | Producción | Host, puerto, credenciales y TLS del servidor de correo. |
| `PB_DEMO_ENABLED` | No | Crea una empleada de ejemplo cuando vale `true`. |
| `PB_DEMO_EMAIL` | Demo | Correo de la empleada de ejemplo. |
| `PB_DEMO_PASSWORD` | Demo | Contraseña de la empleada de ejemplo. |

Las variables de bootstrap crean registros si no existen; no sobrescriben
contraseñas ni datos ya guardados.

## Pruebas y calidad

```bash
cd web
npm ci
npm run build
npm run test:ci
npm run e2e
npm audit --omit=dev

cd ..
docker build -t openjornada .
docker compose -f docker-compose.production.yml config --quiet
```

Playwright crea una base temporal y no toca los datos de desarrollo o producción.
Para E2E local necesita `backend/bin/pocketbase` y los navegadores de Playwright:

```bash
cd web
npx playwright install chromium
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
  FACTORIAL_FEATURES.md
scripts/
  e2e-server.sh
web/
  e2e/             recorridos Playwright
  src/app/core/    autenticación y dominio compartido
  src/app/features módulos funcionales
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
