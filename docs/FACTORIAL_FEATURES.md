# Cobertura funcional inspirada en Factorial

Esta aplicación implementa una suite local de RR. HH. inspirada en los flujos públicos documentados por Factorial, manteniendo el diseño visual de Aura y sin copiar su marca.

## Funcionalidad implementada

| Área | Cobertura |
| --- | --- |
| Ausencias | Tipos configurables, bolsa anual, ajustes y arrastre, cálculo de días laborables, festivos, medias jornadas, periodos bloqueados, prevención de solapamientos, adjuntos obligatorios por tipo, solicitud, asignación por responsables, aprobación/rechazo, calendario y avisos. |
| Gastos | Categorías y límites, borradores, justificantes protegidos, envío, revisión, solicitud de cambios, aprobación, rechazo y pago. |
| Documentos | Archivos protegidos, categorías, visibilidad personal/empresa/gestión, descarga autenticada y confirmación de lectura. |
| Onboarding y tareas | Asignación por administración o responsables, categorías, fechas límite, obligatoriedad, progreso, cierre y avisos. |
| Objetivos | Ciclos, fecha límite, visibilidad, progreso porcentual y finalización. |
| Tiempo | Fichaje, pausas, horarios, correcciones aprobadas, trazabilidad criptográfica, informes y exportación. |
| Organización | Roles, personas, avisos internos, informes y ajustes aislados por empresa. |

## Permisos principales

- `admin`: configura políticas y saldos, asigna ausencias, aprueba solicitudes y gastos, gestiona documentos, tareas y objetivos.
- `manager`: revisa solicitudes y gastos y gestiona tareas/objetivos dentro de la empresa.
- `employee`: solicita ausencias, presenta gastos, consulta sus documentos, confirma lecturas y actualiza sus tareas y objetivos.
- `representative`: conserva acceso de consulta laboral según las reglas existentes, sin permisos administrativos.

Todas las decisiones de aprobación y los cambios de estado se validan en PocketBase; ocultar un botón en la interfaz no es el control de seguridad.

## Límites deliberados

- La confirmación de lectura no es una firma electrónica avanzada o cualificada. Una firma con valor probatorio reforzado necesita integrar un proveedor de firma e identidad.
- No se incluyen nómina, selección ATS completa, evaluación 360, beneficios, control de dispositivos ni integraciones contables externas.
- Los permisos de responsables son por empresa. Para estructuras complejas haría falta añadir departamentos, centros de coste y cadenas de aprobación multinivel.

## Referencias funcionales

- [Ausencias y aprobaciones](https://help.factorialhr.com/es_ES/ausencias-y-aprobaciones/sobre-ausencias-y-aprobaciones)
- [Aprobar y rechazar ausencias](https://help.factorialhr.com/es_ES/como-aprovar-e-rejeitar-pedidos-de-ausencia)
- [Contadores de ausencias](https://help.factorialhr.com/es_ES/comprendre-les-compteurs-dabsences)
- [Calendario de ausencias](https://help.factorialhr.com/es_ES/ausencias-y-aprobaciones/sobre-el-calendario-de-ausencias)
- [Gastos para empleados, responsables y finanzas](https://help.factorialhr.com/es_ES/introduccion-a-los-gastos/benefits-for-employees-approvers-and-finance)
- [Gestión de documentos](https://help.factorialhr.com/es_ES/gestion-de-documentos/sobre-documentos)
- [Flujo de onboarding](https://help.factorialhr.com/es_ES/flujos-de-trabajo-y-automatizaciones/onboarding-workflow)
- [Objetivos](https://help.factorialhr.com/es_ES/competencias-y-objetivos/sobre-la-funcionalidad-de-objetivos)
- [Firma electrónica](https://help.factorialhr.com/es_ES/firma-electronica/sobre-la-firma-electr%C3%B3nica)
