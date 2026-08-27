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
| Tiempo              | Fichaje en tiempo real con revisión de la hora al finalizar, motivo obligatorio en ajustes materiales y conservación separada de hora de servidor/hora aplicada. El objetivo y el progreso del panel usan la planificación diaria o, en modo flexible, el total semanal contratado. Si no existe planificación diaria aplicable, se muestra claramente «Sin planificación» y nunca se presupone una jornada de ocho horas. Hoja diaria y mensual, horas trabajadas/planificadas, balance y horas extra; resúmenes mensuales inmutables con versiones, entrega, acuse y separación de horas ordinarias, complementarias y extraordinarias. El CSV de cada resumen replica minutos planificados y todas las clasificaciones y filas diarias junto a su huella. Los contratos con distribución variable admiten planificaciones delimitadas por semana o un cómputo semanal flexible sin franjas fijas: los fichajes se acumulan contra la cuota semanal y los días de referencia sólo valoran ausencias y festivos. En tiempo completo, el exceso semanal se clasifica como extraordinario; en tiempo parcial sólo como complementario cuando existe pacto. Los tramos históricos archivados conservan su efecto. La UI diferencia planes próximos, vigentes, finalizados y archivados. Informes genera un Excel de inspección con rango editable —cuatro años por defecto y máximo—, hoja resumen y una hoja diaria por empleado activo o inactivo, con entradas, salidas, pausas, ausencias, incidencias y huellas. El empleado puede declarar jornadas actuales o pasadas con trabajo y pausas; para hoy sólo se aceptan tramos terminados. Festivos y ausencias aprobadas ajustan la planificación. Altas, correcciones y resoluciones conservan trazabilidad criptográfica. Los paquetes JSON verifican hashes, enlaces, raíz y punta. |
| Organización        | Roles, perfiles de contrato completo/parcial, minutos semanales, modo de cómputo, días laborables de referencia y pacto de horas complementarias; personas, invitaciones de 72 horas, aviso de privacidad versionado, avisos internos, informes y ajustes aislados por empresa. Administración puede actualizar la razón social y el NIF, asigna horarios en bloque, configura identidad corporativa y crea preservaciones legales por empresa/persona/periodo. La vista previa de retención nunca ejecuta borrados.                                                                                                             |
| Integraciones       | Servidor MCP remoto Streamable HTTP para administración y responsables. Expone herramientas explícitas de equipo, jornada, horarios, ausencias, gastos, documentos, tareas, objetivos y avisos; reutiliza las reglas y hooks de PocketBase. Los tokens se muestran una sola vez, se almacenan como hash, caducan como máximo en seis meses y pueden revocarse. La guía para conectar Codex muestra automáticamente el endpoint derivado de `PB_PUBLIC_URL`. Los archivos protegidos usan enlaces firmados de cinco minutos. La API RFID v1 usa una credencial independiente por terminal, revocable y rotatoria, un PIN empresarial con sesión limitada y asignaciones de UID cifradas. Al crear o rotar una key, la UI puede generar sólo en el cliente y durante esa vista un QR para que la cámara nativa del móvil abra el portal y autocomplete Wi-Fi, URL y credencial. Integraciones y el backend no persisten los datos Wi-Fi ni el QR; la key sigue activa hasta rotarla o revocarla. La entrada manual permanece disponible y, sólo tras confirmación, validación y `bootstrap`, el terminal guarda localmente la configuración validada. El firmware USB para M5Stack Basic Core v2.7 y Unit RFID2 incluye portal móvil, fichaje online/offline, caché A/B, outbox durable, replay tras reinicio, sincronización idempotente y asignación local de tags; no incluye OTA. Resuelve de forma guiada el siguiente estado de jornada, admite correcciones de pausas olvidadas en jornadas de cuatro horas o más y registra la evidencia del dispositivo. La cola offline se firma, exige NTP nuevo tras cada arranque y caduca a las 24 horas sin refresco, se procesa por hora y secuencia y deriva conflictos o tarjetas revocadas a incidencias revisables. El simulador de desarrollo reproduce pantalla 320 × 240, botones, lector, reloj, red y reinicio. MCP no permite cambiar ajustes globales, SMTP, retención, identidad corporativa ni catálogos de política. |
| Aplicación          | SPA responsive e instalable como PWA, con manifiesto dinámico por empresa, iconos estándar y adaptativos generados automáticamente desde el logotipo corporativo, accesos rápidos y shell estático disponible sin conexión. Durante una jornada activa o pausada, un widget flotante persistente muestra el tiempo efectivo y permite pausar, reanudar o finalizar desde cualquier sección. Su asa permite recolocarlo temporalmente dentro del viewport mediante puntero o teclado. En navegadores de escritorio compatibles se puede trasladar mediante Document Picture-in-Picture a una ventana del sistema siempre visible. La preferencia local, activada inicialmente, permite abrirlo dentro del mismo clic de inicio de jornada; requiere contexto seguro. Las API autenticadas y los datos laborales no se almacenan en la caché PWA. |

El portal de aprovisionamiento del terminal M5Stack permanece activo hasta
guardar una configuración válida o cancelar manteniendo C tres segundos; al
cancelar reinicia con la configuración anterior. La pantalla entra en reposo
tras diez minutos sin pulsaciones, pero el punto de acceso sigue disponible;
A, B o C la despiertan y reinician el plazo.

El gesto A+B mantenido cinco segundos abre ese portal desde cualquier estado
del terminal, también durante los reintentos de conexión. La cuenta atrás se
cancela al soltar, no genera acciones de jornada y conserva credenciales,
caché y cola local. El borrado completo sigue requiriendo el gesto físico
separado A+B+C del arranque y su confirmación con C.

Las actualizaciones normales por USB conservan la configuración validada del
terminal en NVS sin reducir la geometría publicada de esa partición. Como la
aplicación arranca desde una partición `factory`, la carga excluye los
metadatos OTA innecesarios que ocuparían parte de NVS. La compilación comprueba
la tabla y las direcciones efectivas de carga; sólo el gesto de
restablecimiento confirmado o un borrado completo explícito de la flash
eliminan las credenciales guardadas.

La asignación local de tags conserva la lista para enlazar varias tarjetas
seguidas y muestra `A+C durante 3 s` como salida explícita en todas sus
pantallas. Si pasan cinco minutos sin botones ni lecturas RFID, la sesión
administrativa se elimina de memoria y el terminal vuelve directamente a
**Acerca tu tarjeta**, incluso si una petición de red estaba en curso. El plazo
empieza al abrir el PIN, cada interacción lo reinicia y los tags presentados
fuera de la pantalla de asignación se ignoran. El simulador aplica el mismo
comportamiento.

Durante el funcionamiento normal, diez minutos sin botones ni lecturas RFID
apagan únicamente la pantalla. Wi-Fi, RFID, sincronización y cola local siguen
activos. La primera pulsación despierta la pantalla y se consume hasta soltar
todos los botones para impedir acciones a ciegas; acercar un tag la despierta y
procesa el fichaje inmediatamente.

Las acciones de terminar pausa y terminar jornada muestran un selector de hora
antes de registrar el evento. Parte siempre del instante en que se leyó el tag,
admite ajustes de cinco minutos y conserva los límites del estado vigente. Si
se cierra una jornada con una pausa abierta, se confirma primero el fin de la
pausa y después, en un segundo selector, el fin de jornada, sin exigir una nueva
lectura. El firmware y el simulador reproducen el mismo recorrido online y
offline.

El inventario de terminales RFID se pagina en el servidor de diez en diez y se
ordena por estado y fecha de creación: activos primero y, dentro de cada estado,
los más recientes primero.

Cada terminal activo envía telemetría operativa mediante un heartbeat
silencioso cada 15 segundos desde un worker aislado del fichaje y de su cola
offline. Integraciones muestra el último contacto y sincronización, reloj/NTP,
señal Wi-Fi, uptime, versión, protocolo, revisión de caché y pendientes. El
estado se deriva sin guardar historial: pasa a **Sin conexión** al alcanzar 45
segundos sin heartbeat y **Revocado** prevalece siempre.

`admin` y `manager` pueden usar **Comprobar conexión**. La comprobación espera
como máximo 20 segundos y es silenciosa en el M5Stack: no cambia la pantalla,
no emite sonido y no interrumpe un fichaje. Las IP local y pública sólo forman
parte de esa respuesta; no se guardan en PocketBase, logs, auditoría ni
almacenamiento del navegador y desaparecen de la web a los 10 minutos, al
recargar o al abandonar Integraciones. No se implementan historial, gráficas
ni alertas de disponibilidad.

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
