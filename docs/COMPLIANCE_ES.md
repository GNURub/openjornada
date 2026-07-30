# Cumplimiento del registro de jornada en España

Última revisión técnica: 29 de julio de 2026.

Este documento describe las salvaguardas incorporadas y las decisiones que la empresa debe completar. No sustituye el asesoramiento laboral o de protección de datos ni la consulta del convenio colectivo aplicable.

## Requisitos cubiertos técnicamente

El artículo 34.9 del Estatuto de los Trabajadores exige un registro diario con el horario concreto de inicio y finalización, conservación durante cuatro años y disponibilidad para personas trabajadoras, representación legal e Inspección de Trabajo.

| Obligación o riesgo | Control de OpenJornada |
| --- | --- |
| Inicio y final concretos | Eventos `clock_in` y `clock_out` con fecha y hora asignadas por PocketBase. |
| Pausas | Eventos explícitos `break_start` y `break_end`; el cálculo de tiempo efectivo las excluye. |
| Fiabilidad e invariabilidad | La API impide actualizar o borrar `work_events`; cada evento enlaza su hash con el anterior. |
| Correcciones trazables | La persona solicita una corrección motivada; administración o responsables la aprueban o rechazan. Al aprobarse se crea un evento corrector inmutable, vinculado al original y al actor, sin sobrescribirlo. |
| Conservación de cuatro años | No existe borrado de eventos en la API. La organización almacena `retentionYears >= 4`. La política de backup debe respetarlo. |
| Acceso de la persona trabajadora | La vista Registros permite consultar y descargar CSV propios por fechas. |
| Representación legal | El rol `representative` puede consultar registros de su empresa y exportarlos. |
| Inspección | Administración puede seleccionar una persona, consultar un periodo y entregar un CSV junto con la cadena de integridad. |
| Control de acceso | Reglas por organización y rol en PocketBase, reforzadas por hooks contra elevación de privilegios. |
| Minimización | No se recoge geolocalización, biometría ni IP; los logs de PocketBase no guardan IP. |
| Información y ejercicio de derechos | La empresa debe entregar la cláusula informativa y completar sus datos; el producto conserva la fecha de aceptación. |

Referencias oficiales:

- [Artículo 34.9 del Estatuto de los Trabajadores (BOE)](https://www.boe.es/buscar/act.php?id=BOE-A-2015-11430)
- [Real Decreto-ley 8/2019 (BOE)](https://www.boe.es/buscar/act.php?id=BOE-A-2019-3481)
- [Criterio de la AEPD sobre registro horario](https://www.aepd.es/preguntas-frecuentes/3-proteccion-de-datos-en-el-ambito-laboral/FAQ-0311-es-necesario-el-consentimiento-del-trabajador-para-implantar-un-sistema-de-control-horario)
- [Protección de datos y relaciones laborales (AEPD)](https://www.aepd.es/guias/la-proteccion-de-datos-en-las-relaciones-laborales.pdf)

## Tareas obligatorias antes de producción

1. Determinar el convenio colectivo aplicable al centro de estética y revisar si establece pausas, resúmenes, acceso o forma documental adicionales.
2. Organizar el registro mediante negociación colectiva, acuerdo de empresa o decisión empresarial previa consulta a la representación legal, según corresponda.
3. Entregar una cláusula informativa RGPD a todo el personal. La base jurídica general del registro es el cumplimiento de una obligación legal, no el consentimiento.
4. Completar el Registro de Actividades de Tratamiento: responsable, finalidad, categorías, destinatarios, conservación, transferencias y medidas de seguridad.
5. Definir quién tendrá los roles de administración, responsable y representación legal; revisarlos al menos cada trimestre.
6. Configurar HTTPS, SMTP, una clave de cifrado única, contraseñas robustas y acceso restringido al panel PocketBase.
7. Implantar backups diarios cifrados, monitorización, un procedimiento de restauración probado y un plan de respuesta a brechas.
8. Documentar el procedimiento de corrección: petición de la persona, motivo, autorización y conservación del evento original.
9. Validar la exportación con la asesoría laboral y realizar una prueba de entrega ante una simulación de inspección.

Las funciones de ausencias, horarios, avisos e informes apoyan la gestión interna, pero no sustituyen la política laboral de la empresa, el convenio aplicable ni los procedimientos formales de comunicación.

## Política sugerida de conservación

- Mantener eventos, correcciones y auditoría durante un mínimo de cuatro años desde su fecha.
- Mantener backups suficientes para garantizar el mismo periodo sin prolongar indefinidamente datos no necesarios.
- Suspender cualquier borrado relacionado con un litigio, una inspección o una obligación de bloqueo.
- Eliminar o anonimizar al finalizar el plazo sólo conforme a la política aprobada por la empresa y sus obligaciones adicionales.

## Cláusula informativa mínima a adaptar

> Responsable: [RAZÓN SOCIAL Y NIF]. Finalidad: gestionar y acreditar el registro diario de jornada. Base jurídica: cumplimiento de la obligación legal prevista en el artículo 34.9 del Estatuto de los Trabajadores. Destinatarios: representación legal de las personas trabajadoras y autoridades competentes cuando proceda. Conservación: cuatro años, sin perjuicio de los periodos de bloqueo exigibles. Derechos: pueden ejercitarse ante [CONTACTO DE PRIVACIDAD]. Puede reclamarse ante la Agencia Española de Protección de Datos.

La empresa debe completar y revisar este texto con su DPD o asesoría. No debe introducir biometría o geolocalización sin un análisis específico de necesidad, proporcionalidad y riesgos.
