# Firmware OTA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publicar firmware firmado en GitHub Releases y actualizar automáticamente el terminal M5Stack con A/B y rollback.

**Architecture:** Un contrato de manifiesto firmado desacopla la publicación de la instalación. Un trabajador OTA independiente aplica las políticas puras, descarga sobre el slot inactivo y reporta una instantánea segura mediante el heartbeat existente.

**Tech Stack:** PlatformIO, Arduino-ESP32/ESP-IDF OTA, Monocypher Ed25519, GitHub Actions, PocketBase Go hooks, Angular 22.

**Spec:** `docs/superpowers/specs/2026-08-27-firmware-ota-design.md`

## Global Constraints

- Mantener NVS en `0x9000` y LittleFS en `0x410000` sin borrarlos.
- Producción acepta únicamente HTTPS, release estable, placa `m5stack-basic-core-v27` y firmas Ed25519 válidas.
- El actualizador nunca bloquea el flujo de fichaje y nunca instala con acciones pendientes.
- El tamaño de aplicación no puede superar el 85 % de `0x1f0000`.

---

### Task 1: Contrato y particiones OTA

- [x] Añadir tests de manifiesto, SemVer, política de instalación y layout A/B.
- [x] Implementar los tipos puros y hacer pasar los tests nativos.
- [x] Cambiar la tabla de particiones y adaptar el validador/carga USB preservando datos.
- [x] Compilar los tres perfiles del M5Stack.

### Task 2: Verificación, descarga y rollback

- [x] Integrar Ed25519 fijado y la clave pública de producción.
- [x] Implementar el cliente HTTPS restringido y la escritura en el slot inactivo.
- [x] Añadir el trabajador OTA independiente y conectarlo al ciclo principal.
- [x] Persistir intentos, bloqueos y confirmación de arranque en NVS.

### Task 3: Publicación en GitHub Releases

- [x] Generar binario, manifiesto determinista, firma y paquete de licencias.
- [x] Verificarlos dentro de la Action y subir el manifiesto en último lugar.
- [x] Publicar también el paquete como artefacto temporal de CI.

### Task 4: Telemetría y UI

- [x] Ampliar el codec del heartbeat y sus pruebas.
- [x] Añadir la migración PocketBase y validación Go multiempresa.
- [x] Presentar estado, objetivo, última comprobación y error seguro en Integraciones.
- [x] Cubrir modelos, helpers, componente y recorrido E2E.

### Task 5: Validación y documentación

- [x] Ejecutar tests nativos, compilaciones del firmware, Go, Angular y E2E.
- [x] Verificar Docker y workflows.
- [x] Actualizar README, despliegue, funcionalidades, cumplimiento y avisos de terceros.
- [x] Ejecutar revisión de código y corregir hallazgos antes del commit final.
