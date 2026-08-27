# Diseño de actualizaciones OTA del terminal

## Objetivo

Publicar el firmware del M5Stack como assets firmados de cada GitHub Release y permitir que los terminales de producción instalen automáticamente la última versión estable sin interrumpir fichajes ni perder configuración o acciones pendientes.

## Distribución y confianza

- La release publica `openjornada-m5stack.bin`, `openjornada-m5stack-manifest.json`, `openjornada-m5stack-manifest.sig` y `openjornada-m5stack-licenses.tar.gz`.
- El manifiesto se firma con Ed25519 usando una clave privada exclusiva de GitHub Actions; el firmware incorpora únicamente la clave pública.
- El dispositivo verifica la firma antes de interpretar el manifiesto y después comprueba placa, protocolo, versión SemVer, tamaño y SHA-256 del binario.
- Producción consulta solo la última release estable del repositorio público `GNURub/openjornada`. Desarrollo no actualiza automáticamente y el perfil de pruebas usa servidor y clave separados.
- Las consultas se ejecutan en segundo plano una vez por hora. Los fallos de consulta son silenciosos y nunca bloquean el control horario.

## Instalación y recuperación

- La flash conserva NVS y LittleFS en sus offsets actuales y sustituye la partición `factory` por dos particiones OTA, más `otadata`.
- La primera instalación requiere USB. La carga USB escribe `ota_0`, reinicializa solamente `otadata` y preserva NVS y LittleFS.
- Solo se instala con cola pendiente vacía, red principal inactiva, modo administrativo cerrado, dos minutos sin interacción y evidencia reciente de un servidor compatible, obtenida por el `bootstrap` o por un heartbeat autenticado correcto.
- La descarga se escribe en la partición inactiva. El firmware nuevo valida almacenamiento e inicialización local antes de confirmar el arranque; si falla, el bootloader revierte.
- Una combinación versión/hash revertida queda bloqueada en NVS para evitar bucles. USB continúa disponible como recuperación permanente.
- La intención de arranque se persiste antes de seleccionar el nuevo slot. Si NVS falla, la instalación se aborta; un corte posterior se clasifica de forma conservadora como intento para no reinstalar indefinidamente una imagen defectuosa.

## Observabilidad

El heartbeat comunica el estado OTA, versión objetivo, última comprobación y un código de error seguro. PocketBase guarda únicamente la última instantánea y la tarjeta del terminal en Integraciones presenta estados comprensibles en español. La primera versión no incluye actualización manual.

## Criterios de aceptación

- La compilación falla si el binario supera el 85 % del slot OTA.
- La Action comprueba firma y hash y deja los cuatro assets en la release.
- El terminal rechaza manifiestos alterados, placas/protocolos incompatibles y downgrades.
- Una actualización válida alterna de slot, conserva datos y se detecta en un máximo de una hora.
- Una imagen que no supera la autocomprobación revierte y no se reintenta.
- El flujo se valida en tests nativos, Go, Angular/E2E y finalmente en el M5Stack real.
