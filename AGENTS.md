# Guía de trabajo de OpenJornada

Este archivo se aplica a todo el repositorio.

## Objetivo y arquitectura

OpenJornada es una aplicación multiempresa de gestión laboral:

- Angular 22 y Tailwind CSS 4 generan una SPA standalone.
- PocketBase 0.39.9 sirve API, autenticación, archivos y frontend compilado.
- `backend/pb_migrations/` contiene el esquema y las reglas de acceso.
- `backend/pb_hooks/` contiene validaciones y efectos de servidor.
- Docker produce un único contenedor con datos persistentes en `/app/pb_data`.

El idioma de la interfaz y de la documentación funcional es español.

## Preparación

```bash
cp .env.example .env
openssl rand -hex 16
# Pega el resultado en PB_ENCRYPTION_KEY.
docker compose up -d --build app

cd web
npm ci
```

No leas, muestres ni confirmes el contenido de `.env`. Nunca lo añadas a Git.

## Comandos de verificación

Desde `web/`:

```bash
npm run build
npm run test:ci
npm run e2e
npm audit --omit=dev
```

Desde la raíz:

```bash
docker compose -f docker-compose.production.yml config --quiet
docker build -t openjornada .
```

Antes de entregar cambios funcionales deben pasar compilación y pruebas unitarias.
Ejecuta E2E cuando cambien flujos, permisos, hooks, rutas o formularios.

## Convenciones del frontend

- Usa componentes standalone, señales y `computed` siguiendo el código existente.
- Mantén la carga diferida de las rutas funcionales.
- Conserva el sistema visual de OpenJornada y el comportamiento responsive.
- Usa textos de interfaz claros en español y etiquetas accesibles.
- No confíes en la UI para autorizar acciones.
- Añade pruebas unitarias para cálculos de dominio y Playwright para recorridos.

## Convenciones de PocketBase

- El servidor es la autoridad para horas, roles, organizaciones y estados.
- Toda colección con datos empresariales debe filtrar por `organization`.
- Valida relaciones para impedir referencias cruzadas entre empresas.
- Trata fichajes y auditorías como datos inmutables.
- Congela los campos no editables durante cambios de estado.
- Crea una migración nueva para cualquier cambio posterior a una migración publicada.
- El bootstrap debe ser idempotente.
- Los adjuntos sensibles deben ser campos protegidos y descargarse con token.

## Seguridad

- No registres contraseñas, tokens, claves, IP, documentos ni recibos.
- No debilites reglas para resolver un problema de interfaz.
- Los roles administrativos son `admin` y, donde proceda, `manager`.
- `representative` sólo debe recibir el acceso laboral expresamente previsto.
- Mantén `PB_DEMO_ENABLED=false` en producción.
- El panel PocketBase `/_/` no debe quedar expuesto públicamente.

## Documentación

Actualiza en el mismo cambio:

- `README.md` cuando varíen instalación, comandos, variables o arquitectura.
- `docs/DEPLOYMENT.md` cuando varíen Docker, proxy, backups o producción.
- `docs/FACTORIAL_FEATURES.md` cuando varíe la cobertura funcional.
- `docs/COMPLIANCE_ES.md` cuando varíen controles relacionados con jornada o privacidad.
- `web/README.md` cuando varíe el flujo específico del frontend.

No afirmes que una confirmación de lectura equivale a una firma electrónica
avanzada o cualificada.

## Git

- Mantén los commits enfocados y no incluyas cambios ajenos.
- No subas `.env`, `backend/pb_data/`, `backend/bin/`, `node_modules/`, `dist/`,
  `playwright-report/` ni `test-results/`.
- Revisa `git diff --check` y el diff completo antes de hacer commit.
