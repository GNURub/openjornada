# Cobertura funcional de OpenJornada

OpenJornada implementa una suite local de RR. HH. centrada en la gestión
laboral, la trazabilidad y el aislamiento de datos entre empresas.

## Funcionalidad implementada

| Área                | Cobertura                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ausencias           | Tipos configurables, bolsa anual, ajustes y arrastre, cálculo de días laborables, festivos, medias jornadas, periodos bloqueados, prevención de solapamientos propios, avisos informativos de coincidencias del equipo al revisar, adjuntos obligatorios por tipo, solicitud, asignación por responsables, aprobación/rechazo, calendario y avisos.                                                                                                                                                                                                                                         |
| Gastos              | Categorías y límites, borradores, justificantes protegidos, envío, revisión, solicitud de cambios, aprobación, rechazo y pago.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Documentos          | Archivos protegidos, categorías, documentos personales, carpetas compartidas con visibilidad de empresa, usuarios seleccionados o sólo responsables, descarga autenticada, avisos internos y por correo, y confirmación individual de lectura.                                                                                                                                                                                                                                                                                                                                              |
| Onboarding y tareas | Asignación por administración o responsables, categorías, fechas límite, obligatoriedad, progreso, cierre y avisos internos y por correo.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Objetivos           | Ciclos, fecha límite, visibilidad, progreso porcentual y finalización.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Tiempo              | Fichaje en tiempo real, hoja diaria y mensual, horas trabajadas/planificadas, balance y horas extra. El empleado puede declarar jornadas del día actual o pasadas con tramos explícitos de trabajo y pausa, incluso nocturnos; para hoy sólo se aceptan tramos ya terminados. La empresa configura pausas remuneradas/no remuneradas y aplicación automática o aprobación por responsables. Festivos y ausencias aprobadas ajustan la planificación. Las solicitudes se pueden cancelar mientras están pendientes y todo alta, corrección y resolución conserva trazabilidad criptográfica. |
| Organización        | Roles, personas, invitaciones de acceso por correo con caducidad de 72 horas y estado pendiente/aceptada, avisos internos, informes y ajustes aislados por empresa. La administración puede asignar un mismo horario a varias personas mediante un selector múltiple con búsqueda y una operación transaccional, y definir colores corporativos, logotipo y nombre propios de la PWA.                                                                                                                                                                                                       |
| Aplicación          | SPA responsive e instalable como PWA, con manifiesto dinámico por empresa, iconos estándar y adaptativos generados automáticamente desde el logotipo corporativo, accesos rápidos y shell estático disponible sin conexión. Las API autenticadas y los datos laborales no se almacenan en la caché PWA.                                                                                                                                                                                                                                                                                     |

## Permisos principales

- `admin`: configura políticas y saldos, asigna ausencias, aprueba solicitudes y gastos, gestiona documentos, tareas y objetivos.
- `manager`: revisa solicitudes y gastos y gestiona tareas/objetivos dentro de la empresa.
- `employee`: solicita ausencias, presenta gastos, consulta sus documentos, confirma lecturas y actualiza sus tareas y objetivos.
- `representative`: conserva acceso de consulta laboral según las reglas existentes, sin permisos administrativos.

Todas las decisiones de aprobación y los cambios de estado se validan en PocketBase; ocultar un botón en la interfaz no es el control de seguridad.

Administración y responsables pueden enviar o renovar desde **Tu equipo** una
invitación para las personas que tienen permitido gestionar. El enlace es
aleatorio, de un solo uso y válido durante 72 horas. Sólo se almacena su hash;
al aceptarlo, la persona define una contraseña, su correo queda verificado y la
SPA inicia la sesión automáticamente. El listado distingue accesos sin
invitación, pendientes, caducados y aceptados.

Las jornadas manuales admiten la fecha actual y fechas pasadas. PocketBase valida
la zona horaria de la empresa, rechaza cualquier minuto futuro, los cambios de
día, la duración, los solapamientos con
eventos o solicitudes pendientes y la pertenencia de cada tipo de pausa a la
organización. El alta se realiza desde un popover contextual en cada día, con
tramos de trabajo o pausa, horas de inicio y fin y soporte para turnos
nocturnos. No hay un límite de antigüedad funcional; la empresa debe definir su
procedimiento interno y revisar su convenio.

Una jornada actual finalizada o pasada con fichajes puede corregirse directamente desde su fila:
la persona cambia horas, añade trabajo o pausas y anula tramos. La empresa
configura de forma independiente si estas sustituciones necesitan aprobación.
La propuesta conserva el estado anterior, bloquea aprobaciones obsoletas y
aplica la corrección mediante eventos inmutables de anulación y reemplazo. Los
límites de tramos contiguos se mantienen enlazados en el editor. Es posible
eliminar uno o todos los tramos; el formulario muestra el motivo exacto de
cualquier bloqueo y exige una justificación de al menos ocho caracteres.

La identidad corporativa sólo puede modificarla una cuenta `admin` de la misma
organización. Al seleccionar el logotipo, la aplicación genera el icono
cuadrado de la PWA y PocketBase sirve sus variantes para favicon e icono táctil.
El logotipo y los iconos derivados se publican sin autenticación para que el
navegador pueda usar el manifiesto instalable; son recursos de marca y no deben
contener datos personales.

Las carpetas de documentos no admiten subcarpetas. Sus permisos se heredan de
forma obligatoria por todo el contenido y una carpeta con documentos no puede
eliminarse hasta quedar vacía.

## Límites deliberados

- La confirmación de lectura no es una firma electrónica avanzada o cualificada. Una firma con valor probatorio reforzado necesita integrar un proveedor de firma e identidad.
- No se incluyen nómina, selección ATS completa, evaluación 360, beneficios, control de dispositivos ni integraciones contables externas.
- Los permisos de responsables son por empresa. Para estructuras complejas haría falta añadir departamentos, centros de coste y cadenas de aprobación multinivel.
