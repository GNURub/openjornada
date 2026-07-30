# Frontend de OpenJornada

SPA standalone construida con Angular 22, Tailwind CSS 4 y el SDK de PocketBase.
La documentación general está en [../README.md](../README.md).

## Desarrollo

PocketBase debe responder en `http://127.0.0.1:8090`:

```bash
cd ..
docker compose up -d --build app

cd web
npm ci
npm start
```

Abre <http://localhost:4200>. Los cambios se recargan automáticamente.

## Comandos

```bash
npm run build      # compilación optimizada
npm run test:ci    # pruebas unitarias con Vitest
npm run e2e        # Playwright en escritorio, tableta y móvil
npm audit --omit=dev
```

Las pruebas E2E arrancan PocketBase y Angular con una base temporal. Requieren
`../backend/bin/pocketbase` y Chromium instalado mediante:

```bash
npx playwright install chromium
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
