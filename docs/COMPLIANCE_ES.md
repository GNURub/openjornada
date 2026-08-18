# Cumplimiento del registro de jornada en España

Última revisión técnica: 18 de agosto de 2026.

Este documento describe las salvaguardas incorporadas y las decisiones que la empresa debe completar. No sustituye el asesoramiento laboral o de protección de datos ni la consulta del convenio colectivo aplicable.

## Requisitos cubiertos técnicamente

El artículo 34.9 del Estatuto de los Trabajadores exige un registro diario con el horario concreto de inicio y finalización, conservación durante cuatro años y disponibilidad para personas trabajadoras, representación legal e Inspección de Trabajo.

| Obligación o riesgo                    | Control de OpenJornada                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inicio y final concretos               | Eventos `clock_in` y `clock_out`; los inicios usan hora de servidor y los finales pueden revisarse antes de confirmar, siempre dentro del intervalo activo y nunca en el futuro.                                                                                                                                    |
| Pausas                                 | Eventos explícitos `break_start` y `break_end`. Cada tipo se configura como remunerado o no remunerado; sólo las no remuneradas se excluyen del tiempo efectivo.                                                                                                                                                    |
| Fiabilidad e invariabilidad            | La API impide actualizar o borrar `work_events`; cada evento enlaza su hash con el anterior.                                                                                                                                                                                                                        |
| Revisión al finalizar                  | Para ajustes de al menos un minuto se exige motivo. El evento inmutable conserva hora capturada por el servidor, hora aplicada, diferencia en segundos, motivo y versión del cálculo de integridad; la auditoría replica esos metadatos. Una modificación posterior sigue el flujo formal de corrección.                                                                          |
| Correcciones trazables                 | La persona solicita una corrección con un motivo de al menos ocho caracteres; puede sustituir o anular uno o todos los tramos. Administración o responsables la aprueban o rechazan. Al aprobarse se crean eventos correctores inmutables vinculados al original y al actor, sin sobrescribirlo.                    |
| Jornadas olvidadas                     | La persona puede declarar por primera vez una fecha sin fichajes mediante tramos de trabajo y pausa, sin tratar el alta inicial como corrección. Según la política de la empresa, se aplica automáticamente o queda pendiente de aprobación. La solicitud, resolución y eventos generados se enlazan y auditan; los eventos no se editan ni borran. |
| Validación temporal                    | PocketBase interpreta las horas en la zona horaria de la empresa, admite turnos que terminan al día siguiente y rechaza horas futuras, intervalos inválidos y solapamientos con trabajo o solicitudes pendientes.                                                                                                   |
| Calendario laboral                     | Administración guarda la ubicación española del centro y revisa una propuesta antes de importar. La app no sobrescribe fechas existentes, conserva ámbito y fuente, atribuye al proveedor y audita la operación. Los datos agregados no sustituyen al BOE, boletines autonómicos, publicaciones municipales ni al calendario laboral aprobado por la empresa.                  |
| Conservación de cuatro años            | No existe borrado de eventos en la API y `retentionYears >= 4`. Administración puede crear preservaciones legales por empresa, persona y periodo, liberarlas con auditoría y consultar cuántos registros serían candidatos. La vista previa declara `destructiveActionExecuted: false`; no hay purga automática.                                                              |
| Acceso de la persona trabajadora       | La vista Control horario ofrece hoja diaria/mensual, detalle de eventos, solicitudes, CSV y paquete JSON verificable propios. Los resúmenes mensuales inmutables se entregan en la aplicación y permiten un acuse idempotente que no se presenta como firma electrónica.                                                                                                            |
| Representación legal                   | El rol `representative` puede consultar registros y resúmenes de su empresa y exportar los paquetes de evidencia autorizados.                                                                                                                                                                                        |
| Inspección                             | Administración, responsables y representación autorizada pueden descargar desde Informes un Excel con cuatro años por defecto y rango editable de hasta cuatro años. Contiene una hoja resumen y otra por cada empleado activo o inactivo —también si su contrato aún no está clasificado—, con planificación, tiempo trabajado, balance, horas complementarias/extraordinarias, entradas, salidas, pausas, ausencias, incidencias y huellas. También pueden seleccionar una persona y periodo para entregar CSV y JSON con todos los campos probatorios y comprobar hash de cada evento, predecesores, raíz y punta de la cadena. |
| Jornada parcial y extraordinaria       | El perfil distingue tiempo completo/parcial, minutos semanales contratados, modo de cómputo y existencia de pacto de horas complementarias. Una distribución variable puede documentarse con planificaciones semanales vigentes o con cómputo semanal flexible sin franjas fijas. En este último, los fichajes reales se acumulan contra la cuota semanal y nunca se convierten retroactivamente en planificación; los días de referencia sólo permiten valorar ausencias y festivos. El exceso semanal es extraordinario en tiempo completo y complementario en tiempo parcial únicamente cuando existe pacto. El cierre mensual bloquea contratos sin clasificar, secuencias anómalas, solicitudes pendientes, meses sin planificación aplicable en modo planificado y excesos parciales sin pacto. El CSV conserva los totales, la huella y el desglose diario. |
| Control de acceso                      | Reglas por organización y rol en PocketBase, reforzadas por hooks contra elevación de privilegios.                                                                                                                                                                                                                  |
| Fichaje mediante terminal RFID         | Cada terminal usa una credencial independiente que puede rotarse o revocarse. La relación entre UID y persona está aislada por empresa, el valor se cifra y nunca se muestra después de asignarlo; no se escribe información personal en la tarjeta. Los eventos conservan terminal, hora de recepción, hora del dispositivo, última sincronización y secuencia. Las acciones offline se firman y los conflictos se convierten en incidencias que deben corregirse antes del cierre. Un tag basado sólo en UID puede clonarse: su presentación no equivale a autenticación fuerte ni sustituye los procedimientos de custodia, corrección y supervisión. |
| Automatización MCP                     | Tokens individuales de administración o responsables, almacenados sólo como hash, con caducidad máxima de seis meses, revocación, límite de peticiones y reevaluación del rol en cada acceso. Las herramientas reutilizan las reglas y validaciones del servidor; su auditoría no conserva argumentos ni contenido. |
| Descargas mediante MCP                 | Los adjuntos y documentos protegidos se sirven a través de enlaces firmados de cinco minutos. La descarga vuelve a comprobar vigencia del token, cuenta activa, rol, empresa y acceso al registro, y responde con `no-store`.                                                                                       |
| Invitaciones de acceso                 | Los enlaces se generan con aleatoriedad criptográfica, sólo se almacena su hash, caducan a las 72 horas y quedan inutilizados al aceptarse o sustituirse. El envío y la aceptación se auditan sin registrar el token ni la contraseña.                                                                              |
| Minimización                           | No se recoge geolocalización, biometría ni IP; los logs de PocketBase no guardan IP.                                                                                                                                                                                                                                |
| Carpetas documentales                  | Los documentos compartidos heredan obligatoriamente el acceso de su carpeta: empresa, personas seleccionadas o sólo responsables. Los archivos siguen protegidos y cada relación se valida contra la organización autenticada.                                                                                      |
| Identidad corporativa                  | Sólo administración puede modificarla. El icono PWA y los favicons se derivan automáticamente del logotipo. El logotipo y sus variantes se sirven públicamente por requisitos del navegador, por lo que deben limitarse a recursos de marca sin datos personales.                                                   |
| Confirmación de documentos compartidos | Cada persona confirma su propia lectura mediante un registro independiente y trazable. La confirmación acredita una acción en la aplicación, no una firma electrónica avanzada o cualificada.                                                                                                                       |
| Avisos de documentos y tareas          | El correo sólo informa de que hay un elemento disponible; no incluye título, categoría, descripción, adjunto ni enlace de descarga. El acceso exige autenticación.                                                                                                                                                  |
| Información y ejercicio de derechos    | El aviso muestra responsable/NIF, finalidad, base jurídica, destinatarios, conservación, derechos y contacto. Sólo administración puede cambiar la razón social o el NIF; cuando el cambio afecte al aviso, debe actualizar también su versión para solicitar una nueva confirmación. La versión y fecha de recepción quedan registradas. Es confirmación de recepción, no consentimiento ni firma.                                                       |

Referencias oficiales:

- [Artículo 34.9 del Estatuto de los Trabajadores (BOE)](https://www.boe.es/buscar/act.php?id=BOE-A-2015-11430)
- [Real Decreto-ley 8/2019 (BOE)](https://www.boe.es/buscar/act.php?id=BOE-A-2019-3481)
- [Criterio de la AEPD sobre registro horario](https://www.aepd.es/preguntas-frecuentes/3-proteccion-de-datos-en-el-ambito-laboral/FAQ-0311-es-necesario-el-consentimiento-del-trabajador-para-implantar-un-sistema-de-control-horario)
- [Protección de datos y relaciones laborales (AEPD)](https://www.aepd.es/guias/la-proteccion-de-datos-en-las-relaciones-laborales.pdf)

## Tareas obligatorias antes de producción

1. Determinar el convenio colectivo aplicable al centro de estética y revisar si establece pausas, resúmenes, acceso o forma documental adicionales.
2. Organizar el registro mediante negociación colectiva, acuerdo de empresa o decisión empresarial previa consulta a la representación legal, según corresponda.
3. Completar el contacto y texto informativo, asignar una versión y entregarlo
   a todo el personal. La base jurídica general es el cumplimiento de una
   obligación legal, no el consentimiento; el acuse de la aplicación sólo
   acredita recepción.
4. Completar el Registro de Actividades de Tratamiento: responsable, finalidad, categorías, destinatarios, conservación, transferencias y medidas de seguridad.
5. Definir quién tendrá los roles de administración, responsable y representación legal; revisarlos al menos cada trimestre.
6. Configurar HTTPS, SMTP, una clave de cifrado única, contraseñas robustas y acceso restringido al panel PocketBase.
7. Implantar backups diarios cifrados, monitorización, un procedimiento de restauración probado y un plan de respuesta a brechas.
8. Documentar el procedimiento de corrección: petición de la persona, motivo, autorización y conservación del evento original.
9. Decidir si las altas retroactivas requieren aprobación, quién las revisa y en
   qué plazo; aunque se introduzcan desde el editor rápido de cada día, exigir
   siempre motivo y trazabilidad, y configurar qué pausas son remuneradas según
   convenio y política interna.
   Para la fecha actual, la aplicación sólo admite periodos que ya hayan
   terminado según la zona horaria de la empresa y mantiene el bloqueo de horas
   futuras en el servidor.
   Definir por separado si las correcciones o anulaciones de fichajes existentes
   requieren aprobación. La aplicación conserva los eventos originales y evita
   sobrescribir o borrar el registro histórico.
10. Clasificar contratos, horas semanales y pactos de horas complementarias;
    establecer quién cierra cada mes, cuándo se resuelven anomalías y cómo se
    entrega el resumen a la plantilla.
11. Validar CSV y JSON con la asesoría laboral y realizar una prueba de entrega
    y verificación ante una simulación de inspección.
12. Revisar periódicamente las personas incluidas en carpetas compartidas y retirar accesos que ya no sean necesarios.
13. Inventariar los clientes MCP autorizados, usar la caducidad mínima viable,
    revisar tokens al menos cada trimestre y revocarlos al terminar la
    integración o cambiar de funciones la persona responsable.
14. Revisar cada año los festivos importados frente al BOE, boletín autonómico y
    calendario municipal aplicables antes de publicar el calendario laboral de
    la empresa; corregir manualmente cualquier diferencia.
15. Inventariar los terminales RFID, limitar el acceso físico, rotar o revocar
    inmediatamente la clave de cualquier dispositivo perdido y revisar las
    incidencias de sincronización antes de cerrar cada mes. Informar a la
    plantilla de que el tag identifica una asignación operativa y puede clonarse;
    no debe presentarse como autenticación fuerte.

Las funciones de ausencias, horarios, avisos e informes apoyan la gestión interna, pero no sustituyen la política laboral de la empresa, el convenio aplicable ni los procedimientos formales de comunicación.

## Política sugerida de conservación

- Mantener eventos, correcciones y auditoría durante un mínimo de cuatro años desde su fecha.
- Mantener backups suficientes para garantizar el mismo periodo sin prolongar indefinidamente datos no necesarios.
- Suspender cualquier borrado relacionado con un litigio, una inspección o una obligación de bloqueo.
- Eliminar o anonimizar al finalizar el plazo sólo conforme a la política aprobada por la empresa y sus obligaciones adicionales.
- Registrar en **Ajustes → Preservaciones legales** cualquier bloqueo antes de
  preparar una depuración. La aplicación actual sólo calcula una vista previa:
  no elimina registros.

## Cláusula informativa mínima a adaptar

> Responsable: [RAZÓN SOCIAL Y NIF]. Finalidad: gestionar y acreditar el registro diario de jornada. Base jurídica: cumplimiento de la obligación legal prevista en el artículo 34.9 del Estatuto de los Trabajadores. Destinatarios: representación legal de las personas trabajadoras y autoridades competentes cuando proceda. Conservación: cuatro años, sin perjuicio de los periodos de bloqueo exigibles. Derechos: pueden ejercitarse ante [CONTACTO DE PRIVACIDAD]. Puede reclamarse ante la Agencia Española de Protección de Datos.

La empresa debe completar y revisar este texto con su DPD o asesoría. No debe introducir biometría o geolocalización sin un análisis específico de necesidad, proporcionalidad y riesgos.
