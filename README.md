# Aura Jornada

Sistema de registro horario para una empresa de estética. La aplicación combina una SPA responsive en Angular 22 y Tailwind CSS 4 con PocketBase 0.39.9. Se despliega como un único contenedor y funciona en escritorio, tablet y móvil.

## Funcionalidad incluida

- Acceso con correo y contraseña, recuperación de contraseña y verificación por correo.
- Roles `admin`, `manager`, `employee` y `representative`, aislados por empresa.
- Alta, activación/desactivación y cambio de rol de personas con controles de elevación de privilegios en servidor.
- Entrada, salida e inicio/fin de pausa con hora asignada por el servidor.
- Secuencia de fichaje validada en backend.
- Eventos inmutables con identificador idempotente, cadena SHA-256 y registro de auditoría.
- Solicitudes de corrección con motivo, aprobación o rechazo y evento corrector inmutable enlazado al original.
- Consulta histórica y exportación CSV para la persona trabajadora, responsables y representación legal.
- Gestión avanzada de ausencias: tipos configurables, saldos por persona y año, días laborables/festivos, medias jornadas, periodos bloqueados, calendario, asignación por responsables, aprobación y avisos.
- Gastos con categorías, justificante protegido, borrador, envío, solicitud de cambios, aprobación, rechazo y marcado como pagado.
- Documentos protegidos por persona o empresa, visibilidad por rol, descarga autenticada y confirmación de lectura.
- Tareas de onboarding, formación y administración, con responsable, vencimiento, estados y avisos.
- Objetivos por ciclos, visibilidad configurable, progreso y cierre.
- Horarios por persona con días, horas, pausa, periodo de vigencia y archivo histórico.
- Avisos internos y comunicados por audiencia, con envío adicional por SMTP cuando está configurado.
- Informes mensuales por persona y empresa, detección de secuencias abiertas y exportación CSV.
- Ajustes de empresa protegidos para administración: zona horaria, conservación y contacto de privacidad.
- Configuración SMTP, limitación de peticiones, minimización de logs y cifrado de secretos.
- Migraciones reproducibles, pruebas unitarias con Vitest y E2E con Playwright en escritorio, tableta y móvil.

## Puesta en marcha con Docker

Requisitos: Docker 26+ y Docker Compose.

```bash
cp .env.example .env
openssl rand -hex 16
```

Edita `.env`, pega la salida de `openssl` en `PB_ENCRYPTION_KEY` y sustituye todas las credenciales de ejemplo. La clave debe tener exactamente 32 caracteres.

```bash
docker compose up -d --build
docker compose ps
```

La aplicación estará en `http://localhost:8090`. En el primer arranque, las variables `PB_BOOTSTRAP_ADMIN_*` crean la empresa y su primera cuenta administradora de forma idempotente.

Para producción:

1. Publica el puerto 8090 únicamente detrás de un proxy HTTPS (Caddy, Traefik, nginx o el proxy de tu proveedor).
2. Configura `PB_PUBLIC_URL` con la URL HTTPS definitiva.
3. Completa los datos SMTP. Sin SMTP no funcionarán los correos de verificación y recuperación.
4. Mantén `PB_DEMO_ENABLED=false`.
5. Guarda el volumen `pocketbase_data` en almacenamiento persistente y configura copias cifradas externas.
6. Restringe el acceso a `/_/` en el proxy o con una lista de IP permitidas para superusuarios.

## Desarrollo local

```bash
# terminal 1 (sólo la primera vez o después de añadir migraciones)
backend/bin/pocketbase migrate up \
  --migrationsDir backend/pb_migrations \
  --hooksDir backend/pb_hooks

# terminal 1 (servidor)
PB_BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
PB_BOOTSTRAP_ADMIN_PASSWORD='change-this-password' \
backend/bin/pocketbase serve \
  --http=127.0.0.1:8090 \
  --migrationsDir backend/pb_migrations \
  --hooksDir backend/pb_hooks

# terminal 2
cd web
npm ci
npm start
```

La descarga local de `backend/bin/pocketbase` se excluye de Git. El contenedor descarga la versión fijada automáticamente.

## Verificación

```bash
cd web
npm run build
npm run test:ci
npm run e2e
npm audit --omit=dev

cd ..
docker build -t aura-jornada .
```

Playwright crea una base PocketBase temporal, una cuenta administradora y una empleada de prueba; no toca datos de desarrollo ni producción.

## Copias de seguridad y restauración

El dato persistente es el volumen `/app/pb_data`. Realiza copias diarias cifradas, conserva varias generaciones y prueba la restauración periódicamente. Antes de una actualización:

```bash
docker compose stop app
docker run --rm \
  -v factorial_pocketbase_data:/source:ro \
  -v "$PWD/backups:/backup" \
  alpine tar -czf /backup/pb_data-$(date +%F).tar.gz -C /source .
docker compose start app
```

No automatices el borrado de `work_events` antes de cuatro años. Consulta [Cumplimiento en España](docs/COMPLIANCE_ES.md) antes de activar el servicio.

## Estructura

```text
backend/
  pb_migrations/   esquema, reglas de acceso y plantillas de correo
  pb_hooks/        validación, integridad, auditoría, SMTP y bootstrap
web/
  src/app/core/    autenticación, modelos y dominio de jornada
  src/app/features acceso, jornada, registros, equipo, ausencias, horarios, avisos, informes y ajustes
  e2e/             recorridos Playwright
docs/
  COMPLIANCE_ES.md controles legales y pasos organizativos
  FACTORIAL_FEATURES.md alcance funcional comparado con Factorial
```

PocketBase sigue antes de su versión 1.0; antes de actualizarlo hay que revisar su changelog, ejecutar todas las pruebas y restaurar una copia en un entorno separado.

La cobertura funcional inspirada en Factorial y sus límites están documentados en [docs/FACTORIAL_FEATURES.md](docs/FACTORIAL_FEATURES.md). La aplicación conserva el diseño visual propio de Aura; no reproduce la marca ni los recursos gráficos de Factorial.
