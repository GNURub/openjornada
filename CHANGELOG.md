# Historial de cambios

Este proyecto sigue [versionado semántico](https://semver.org/lang/es/).

## [0.4.0] - 2026-07-31

### Añadido

- Configuración de la dirección española de la empresa mediante selectores de
  comunidad autónoma, provincia y municipio.
- Previsualización e importación selectiva del calendario laboral nacional,
  autonómico, provincial y local, conservando ámbito, procedencia y auditoría
  sin sobrescribir festivos existentes.
- Gestión completa de festivos desde la interfaz, incluida su creación, edición
  y eliminación manual por administración.
- Calendario anual de ausencias adaptable, detalle de solicitudes del equipo y
  cancelación por la persona empleada mientras la petición siga pendiente.

### Cambiado

- Administración puede modificar la razón social y el NIF desde la interfaz;
  las variables de bootstrap dejan de actuar como configuración permanente.
- Los asuntos propios parten de cero días y los tipos sin saldo no se ofrecen a
  la persona empleada, aunque continúan disponibles para administración.
- El ejemplo para conectar Codex usa `PB_PUBLIC_URL` cuando está configurada y
  mantiene una URL local segura como alternativa.
- La experiencia de solicitud, revisión y resolución de ausencias se reorganiza
  para escritorio, tableta y móvil sin retirar las capacidades existentes.

### Corregido

- Un intervalo cuyo inicio y fin son el mismo día ocupa una sola fecha en el
  calendario.
- Responsables y administración conservan el acceso a las peticiones de
  ausencia y pueden aprobarlas o rechazarlas también desde pantallas pequeñas.
- Se admite configurar en cero tanto vacaciones como asuntos propios sin fallos
  de validación ni saldos engañosos en la interfaz.

### Seguridad y cumplimiento

- La importación de festivos se ejecuta en el servidor con proveedor fijo,
  validación de rutas y datos, límites de respuesta, timeout y caché.
- Sólo administración puede consultar o importar catálogos laborales; cada
  operación permanece aislada por empresa y queda registrada en auditoría.

## [0.3.0] - 2026-07-31

### Añadido

- Servidor OpenJornada en Go sobre PocketBase 0.39.10, con la SPA compilada y
  el servidor MCP remoto en el mismo binario y contenedor.
- Revisión antes de finalizar jornada o pausa, con hora capturada por el
  servidor, hora aplicada, motivo del ajuste y trazabilidad de integridad.
- Aviso de privacidad versionado, resúmenes mensuales inmutables, acuse de
  recepción, preservaciones legales y vista previa no destructiva de retención.
- Clasificación mensual de horas ordinarias, complementarias y extraordinarias,
  con CSV diario verificable y pruebas de jornadas completas y parciales.
- Excel de inspección de hasta cuatro años, con hoja resumen y una hoja por cada
  persona empleada, activa o inactiva.
- Cupos anuales de vacaciones distintos por persona, auditados y expresables en
  días completos o medios días.
- Simulación E2E de un mes con cinco personas, inspección, resúmenes, CSV,
  horas complementarias, horas extraordinarias y vacaciones.
- Integración MCP administrable mediante tokens revocables y herramientas para
  equipo, jornada, ausencias, gastos, documentos, tareas y objetivos.
- Widget persistente de jornada y modo Picture-in-Picture compatible.

### Cambiado

- El cómputo de vacaciones respeta el horario vigente de cada persona, incluidos
  sábados laborables y descansos entre semana.
- Las consultas de fechas usan el formato canónico de PocketBase, restaurando
  correctamente una jornada activa tras recargar y evitando omisiones en
  trazabilidad e informes.
- La documentación de desarrollo, despliegue, producción y cumplimiento se ha
  actualizado para reflejar la arquitectura y los controles actuales.

### Seguridad y cumplimiento

- Se refuerzan la separación por empresa, la autorización de servidor, la
  inmutabilidad de fichajes y auditorías y la descarga autenticada de archivos.
- Los ajustes de jornada conservan por separado la hora original y la aplicada.
- Las preservaciones legales excluyen los registros afectados de cualquier
  futura depuración; no se incorpora una purga automática.

[0.4.0]: https://github.com/GNURub/openjornada/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/GNURub/openjornada/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/GNURub/openjornada/releases/tag/v0.2.0
[0.1.0]: https://github.com/GNURub/openjornada/releases/tag/v0.1.0
