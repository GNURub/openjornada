# Cobertura funcional de OpenJornada

OpenJornada implementa una suite local de RR. HH. centrada en la gestión
laboral, la trazabilidad y el aislamiento de datos entre empresas.

## Funcionalidad implementada

| Área                | Cobertura                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ausencias           | Tipos configurables, cupo anual editable por persona, tipo y año en días completos o medios días, ajustes y arrastre separados, auditoría de cambios, cálculo de días laborables, festivos, medias jornadas, periodos bloqueados, prevención de solapamientos propios, avisos informativos de coincidencias del equipo al revisar, adjuntos obligatorios por tipo, solicitud, asignación por responsables, aprobación/rechazo, calendario y avisos. Administración puede crear, listar por año, editar y eliminar los festivos de su empresa. También puede guardar la dirección española del centro principal mediante selectores de comunidad, provincia y municipio, previsualizar el calendario nacional, autonómico, provincial y local aplicable e importar sólo las fechas seleccionadas. La importación conserva ámbito y fuente, usa caché, no sobrescribe fechas existentes y queda auditada. Los festivos se muestran en los calendarios y no consumen días de ausencia. La persona trabajadora conserva el historial completo, las respuestas y justificantes, y puede cancelar sus solicitudes mientras sigan pendientes. Administración y responsables disponen de una vista de peticiones del equipo con búsqueda, filtros por estado, detalle, justificantes y resolución de pendientes. El resumen combina saldos, historial y calendario anual adaptable a escritorio, tableta y móvil; la solicitud se realiza en un modal con selector visual de duración y rango de fechas. Asuntos propios parte de cero días y los tipos sin saldo configurado se ocultan en tarjetas y nuevas solicitudes, pero permanecen disponibles en administración.                                                              |
| Gastos              | Categorías y límites, borradores, justificantes protegidos, envío, revisión, solicitud de cambios, aprobación, rechazo y pago.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Documentos          | Archivos protegidos, categorías, documentos personales, carpetas compartidas con visibilidad de empresa, usuarios seleccionados o sólo responsables, descarga autenticada, avisos internos y por correo, y confirmación individual de lectura.                                                                                                                                                                                                                                                                                                                                                                                   |
| Onboarding y tareas | Asignación por administración o responsables, categorías, fechas límite, obligatoriedad, progreso, cierre y avisos internos y por correo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Objetivos           | Ciclos, fecha límite, visibilidad, progreso porcentual y finalización.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Tiempo              | Fichaje en tiempo real con revisión de la hora al finalizar, motivo obligatorio en ajustes materiales y conservación separada de hora de servidor/hora aplicada. Hoja diaria y mensual, horas trabajadas/planificadas, balance y horas extra; resúmenes mensuales inmutables con versiones, entrega, acuse y separación de horas ordinarias, complementarias y extraordinarias. El CSV de cada resumen replica minutos planificados y todas las clasificaciones y filas diarias junto a su huella. Los contratos parciales con distribución variable pueden recibir planificaciones delimitadas para cada semana; cada fecha usa el tramo aplicable y los tramos ya terminados conservan su efecto en cierres, ausencias e informes aunque su ficha se archive. Informes genera un Excel de inspección con rango editable —cuatro años por defecto y máximo—, hoja resumen y una hoja diaria por empleado activo o inactivo, con entradas, salidas, pausas, ausencias, incidencias y huellas. El empleado puede declarar jornadas actuales o pasadas con trabajo y pausas; para hoy sólo se aceptan tramos terminados. Festivos y ausencias aprobadas ajustan la planificación. El cómputo de vacaciones usa el horario vigente de cada persona, por lo que admite sábados laborables y descansos entre semana. Altas, correcciones y resoluciones conservan trazabilidad criptográfica. Los paquetes JSON verifican hashes, enlaces, raíz y punta. |
| Organización        | Roles, perfiles de contrato completo/parcial, minutos semanales y pacto de horas complementarias; personas, invitaciones de 72 horas, aviso de privacidad versionado, avisos internos, informes y ajustes aislados por empresa. Administración puede actualizar la razón social y el NIF, asigna horarios en bloque, configura identidad corporativa y crea preservaciones legales por empresa/persona/periodo. La vista previa de retención nunca ejecuta borrados.                                                                                                             |
| Integraciones       | Servidor MCP remoto Streamable HTTP para administración y responsables. Expone herramientas explícitas de equipo, jornada, horarios, ausencias, gastos, documentos, tareas, objetivos y avisos; reutiliza las reglas y hooks de PocketBase. Los tokens se muestran una sola vez, se almacenan como hash, caducan como máximo en seis meses y pueden revocarse. La guía para conectar Codex muestra automáticamente el endpoint derivado de `PB_PUBLIC_URL`. Los archivos protegidos usan enlaces firmados de cinco minutos. No permite cambiar ajustes globales, SMTP, retención, identidad corporativa ni catálogos de política.                                      |
| Aplicación          | SPA responsive e instalable como PWA, con manifiesto dinámico por empresa, iconos estándar y adaptativos generados automáticamente desde el logotipo corporativo, accesos rápidos y shell estático disponible sin conexión. Durante una jornada activa o pausada, un widget flotante persistente muestra el tiempo efectivo y permite pausar, reanudar o finalizar desde cualquier sección. Su asa permite recolocarlo temporalmente dentro del viewport mediante puntero o teclado. En navegadores de escritorio compatibles se puede trasladar mediante Document Picture-in-Picture a una ventana del sistema siempre visible. La preferencia local, activada inicialmente, permite abrirlo dentro del mismo clic de inicio de jornada; requiere contexto seguro. Las API autenticadas y los datos laborales no se almacenan en la caché PWA. |

## Permisos principales

- `admin`: configura políticas y saldos, asigna ausencias, aprueba solicitudes y gastos, gestiona documentos, tareas y objetivos.
- `manager`: revisa solicitudes y gastos y gestiona tareas/objetivos dentro de la empresa.
- `employee`: solicita ausencias, presenta gastos, consulta sus documentos, confirma lecturas y actualiza sus tareas y objetivos.
- `representative`: conserva acceso de consulta laboral según las reglas existentes, sin permisos administrativos.

Todas las decisiones de aprobación y los cambios de estado se validan en PocketBase; ocultar un botón en la interfaz no es el control de seguridad.

Las llamadas MCP se ejecutan con el rol vigente de la persona que creó el
token, no con una copia histórica de sus permisos. Si la cuenta se desactiva,
deja de ser `admin`/`manager`, el token caduca o se revoca, el acceso deja de
funcionar. Cada ejecución registra herramienta, resultado e identificadores
afectados sin guardar argumentos, tokens ni contenido documental.

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
nocturnos. La primera incorporación sobre un día sin historial no solicita
motivo. No hay un límite de antigüedad funcional; la empresa debe definir su
procedimiento interno y revisar su convenio.

Una jornada actual finalizada o pasada con fichajes puede corregirse directamente desde su fila:
la persona cambia horas, añade trabajo o pausas y anula tramos. La empresa
configura de forma independiente si estas sustituciones necesitan aprobación.
La propuesta conserva el estado anterior, bloquea aprobaciones obsoletas y
aplica la corrección mediante eventos inmutables de anulación y reemplazo. Los
límites de tramos contiguos se mantienen enlazados en el editor. Es posible
eliminar uno o todos los tramos; el formulario muestra el motivo exacto de
cualquier bloqueo y exige una justificación de al menos ocho caracteres.
Volver a añadir horas a un día que anteriormente tuvo fichajes, aunque una
corrección los hubiese anulado todos, continúa siendo una corrección.

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
