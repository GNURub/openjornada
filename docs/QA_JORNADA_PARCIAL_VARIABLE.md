# Auditoría de una jornada parcial con horario semanal variable

Fecha de ejecución: 31 de julio de 2026.

Resultado: **135 casuísticas conformes**. Compilación de producción superada,
64 pruebas unitarias superadas y regresión Playwright completa con 54 recorridos
superados y 30 omisiones intencionadas de escenarios desktop-only en los
proyectos responsive.

## Alcance y criterio

La persona base tiene contrato a tiempo parcial de 20 horas semanales y no
tiene pacto de horas complementarias. Su planificación cambia cada semana y
cada tramo conserva fechas de vigencia. Los recorridos de empleado se
complementan con acciones de responsable o administración cuando la operación
lo exige: aprobar, cerrar el mes, preparar una inspección o administrar la
empresa.

Cada identificador de esta matriz representa una regla o resultado de negocio
distinto. No se contabilizan como casos nuevos las repeticiones responsive en
escritorio, tableta y móvil. La evidencia automatizada vive en `web/e2e/`; la
regresión completa es `pnpm run e2e`.

## Matriz de 135 casuísticas

### Acceso, sesión, equipo y permisos

1. `JPV-001` Rechazar credenciales incorrectas sin revelar si existe el correo — comprobación manual de acceso.
2. `JPV-002` Iniciar sesión como empleado activo — `clocking.spec.ts`.
3. `JPV-003` Mantener accesible el formulario de acceso en móvil — `clocking.spec.ts`.
4. `JPV-004` Mostrar nombre y contexto del empleado tras autenticarse — `clocking.spec.ts`.
5. `JPV-005` Cerrar sesión y volver al acceso — `invitations.spec.ts`.
6. `JPV-006` Ocultar Equipo a un empleado — comprobación manual de navegación.
7. `JPV-007` Impedir Equipo por URL directa a un empleado — comprobación manual de rutas.
8. `JPV-008` Impedir Ajustes por URL directa a un empleado — comprobación manual de rutas.
9. `JPV-009` Impedir Informes por URL directa a un empleado — comprobación manual de rutas.
10. `JPV-010` Impedir Integraciones por URL directa a un empleado — comprobación manual de rutas.
11. `JPV-011` Crear una persona indicando rol y contrato — `clocking.spec.ts`.
12. `JPV-012` Crear una invitación con estado inicial correcto — `invitations.spec.ts`.
13. `JPV-013` Enviar el correo de invitación — `invitations.spec.ts`.
14. `JPV-014` Mantener la invitación vigente durante 72 horas — `invitations.spec.ts`.
15. `JPV-015` Permitir definir la contraseña desde el enlace — `invitations.spec.ts`.
16. `JPV-016` Invalidar el enlace una vez utilizado — `invitations.spec.ts`.
17. `JPV-017` Reflejar la invitación aceptada en Equipo — `invitations.spec.ts`.
18. `JPV-018` No reenviar una invitación ya aceptada — `invitations.spec.ts`.

### Planificación semanal variable

19. `JPV-019` Configurar contrato parcial de 1.200 minutos semanales — `weekly-work-patterns.spec.ts`.
20. `JPV-020` Trabajar cuatro días de cinco horas en una semana — `weekly-work-patterns.spec.ts`.
21. `JPV-021` Cambiar esos cuatro días en la semana siguiente — `weekly-work-patterns.spec.ts`.
22. `JPV-022` Repartir 20 horas entre lunes, miércoles y viernes — `weekly-work-patterns.spec.ts`.
23. `JPV-023` Repartir 20 horas entre martes, jueves y sábado — `weekly-work-patterns.spec.ts`.
24. `JPV-024` Asignar el mismo horario a varias personas desde la UI — `clocking.spec.ts`.
25. `JPV-025` Buscar y seleccionar varias personas al asignar horario — `clocking.spec.ts`.
26. `JPV-026` Impedir a un empleado la asignación masiva — `clocking.spec.ts`.
27. `JPV-027` Conservar cuatro planificaciones con vigencia independiente — `weekly-work-patterns.spec.ts`.
28. `JPV-028` Archivar planes pasados sin borrarlos — `weekly-work-patterns.spec.ts`.
29. `JPV-029` Contar planes archivados en cálculos históricos — `weekly-work-patterns.spec.ts`.
30. `JPV-030` Mostrar un plan desactivado como Archivado — `weekly-work-patterns.spec.ts`.
31. `JPV-031` Mostrar un plan activo pero vencido como Finalizado — `weekly-work-patterns.spec.ts`.
32. `JPV-032` Distinguir un plan futuro como Próximo — `schedule-status.spec.ts`.
33. `JPV-033` Mostrar como Activo sólo el plan vigente — `schedule-status.spec.ts`.
34. `JPV-034` Mostrar días, entrada, salida y pausa del plan al empleado — `clocking.spec.ts`.
35. `JPV-035` No inventar un objetivo diario de ocho horas sin plan vigente — `weekly-work-patterns.spec.ts`.
36. `JPV-036` Calcular el progreso diario contra los minutos realmente planificados — `time-calculations.spec.ts`.

### Fichaje y hoja diaria

37. `JPV-037` Mostrar Fuera de jornada antes de fichar — `clocking.spec.ts`.
38. `JPV-038` Registrar entrada con hora capturada por el servidor — `clocking.spec.ts`.
39. `JPV-039` Pasar a Jornada en curso tras la entrada — `clocking.spec.ts`.
40. `JPV-040` Mantener visible el control flotante al navegar — `clocking.spec.ts`.
41. `JPV-041` Permitir mover el control flotante — `clocking.spec.ts`.
42. `JPV-042` Iniciar una pausa — `clocking.spec.ts`.
43. `JPV-043` Mostrar Jornada en pausa — `clocking.spec.ts`.
44. `JPV-044` Revisar la duración antes de finalizar una pausa — `clocking.spec.ts`.
45. `JPV-045` Finalizar la pausa y volver a jornada en curso — `clocking.spec.ts`.
46. `JPV-046` Revisar el tiempo efectivo antes de salir — `clocking.spec.ts`.
47. `JPV-047` Finalizar la jornada — `clocking.spec.ts`.
48. `JPV-048` Restablecer Fuera de jornada tras salir — `clocking.spec.ts`.
49. `JPV-049` Mostrar todos los eventos en Registros — `clocking.spec.ts`.
50. `JPV-050` Descontar las pausas del tiempo efectivo — `clocking.spec.ts`.
51. `JPV-051` Abrir Picture-in-Picture automáticamente si se autoriza — `clocking.spec.ts`.
52. `JPV-052` Respetar la desactivación de Picture-in-Picture — `clocking.spec.ts`.
53. `JPV-053` Restaurar el control al cerrar Picture-in-Picture — `clocking.spec.ts`.
54. `JPV-054` Mantener huella de integridad v2 en los eventos — `compliance.spec.ts`.
55. `JPV-055` Generar evidencia verificable del fichaje — `compliance.spec.ts`.

### Incorporaciones y correcciones manuales

56. `JPV-056` Incorporar una jornada pasada con motivo — `manual-timesheet.spec.ts`.
57. `JPV-057` Mostrar los intervalos incorporados — `manual-timesheet.spec.ts`.
58. `JPV-058` Calcular 7 h 30 min con pausa — `manual-timesheet.spec.ts`.
59. `JPV-059` Precargar tramos existentes al corregir — `manual-timesheet.spec.ts`.
60. `JPV-060` Añadir un nuevo tramo a una jornada — `manual-timesheet.spec.ts`.
61. `JPV-061` Enviar la corrección para aprobación — `manual-timesheet.spec.ts`.
62. `JPV-062` Mantener el total original mientras la corrección está pendiente — `manual-timesheet.spec.ts`.
63. `JPV-063` Rechazar intervalos solapados — `manual-timesheet.spec.ts`.
64. `JPV-064` Aceptar un turno que termina al día siguiente — `manual-timesheet.spec.ts`.
65. `JPV-065` Mostrar Antes y Propuesta al responsable — `manual-timesheet.spec.ts`.
66. `JPV-066` Aprobar una corrección e incorporarla — `manual-timesheet.spec.ts`.
67. `JPV-067` Exigir aprobación según la política de empresa — `manual-timesheet.spec.ts`.
68. `JPV-068` Permitir cancelar una incorporación pendiente — `manual-timesheet.spec.ts`.
69. `JPV-069` Reenviar una incorporación cancelada — `manual-timesheet.spec.ts`.
70. `JPV-070` Anular intervalos conservando trazabilidad — `manual-timesheet.spec.ts`.
71. `JPV-071` Exigir motivo al reincorporar tiempo anulado — `manual-timesheet.spec.ts`.
72. `JPV-072` Conservar enlaces de corrección en el historial — `manual-timesheet.spec.ts`.
73. `JPV-073` Rechazar una jornada futura — `manual-timesheet.spec.ts`.
74. `JPV-074` Rechazar un tramo de duración cero — `manual-timesheet.spec.ts`.
75. `JPV-075` Exigir longitud mínima del motivo — `manual-timesheet.spec.ts`.

### Ausencias, vacaciones y calendario

76. `JPV-076` Ocultar Asuntos propios cuando su cupo es cero — `leave-redesign.spec.ts`.
77. `JPV-077` Mostrar el saldo anual de vacaciones — `leave-redesign.spec.ts`.
78. `JPV-078` Abrir el modal de solicitud de ausencia — `leave-redesign.spec.ts`.
79. `JPV-079` Permitir ausencia de día completo — `leave-redesign.spec.ts`.
80. `JPV-080` Permitir selección Desde/Hasta sin duplicar un único día — `clocking.spec.ts`.
81. `JPV-081` Calcular en servidor un día solicitado aunque el cliente envíe otro valor — `weekly-work-patterns.spec.ts`.
82. `JPV-082` Usar el horario histórico archivado para calcular ese día — `weekly-work-patterns.spec.ts`.
83. `JPV-083` Mostrar la solicitud pendiente en el calendario anual — `clocking.spec.ts`.
84. `JPV-084` Cancelar una solicitud aún pendiente — `clocking.spec.ts`.
85. `JPV-085` Retirar la solicitud cancelada del día del calendario — `clocking.spec.ts`.
86. `JPV-086` Impedir cancelar una ausencia ya resuelta — `clocking.spec.ts`.
87. `JPV-087` Exigir justificante para un tipo que lo requiera — `clocking.spec.ts`.
88. `JPV-088` Admitir la solicitud cuando adjunta justificante — `clocking.spec.ts`.
89. `JPV-089` Conservar el adjunto si la solicitud se cancela — `clocking.spec.ts`.
90. `JPV-090` Avisar al responsable de ausencias aprobadas coincidentes — `clocking.spec.ts`.
91. `JPV-091` Avisar al responsable de solicitudes pendientes coincidentes — `clocking.spec.ts`.
92. `JPV-092` Aprobar una ausencia y notificar al empleado — `clocking.spec.ts`.
93. `JPV-093` Mantener al admin la gestión de peticiones — `clocking.spec.ts`.
94. `JPV-094` Crear manualmente un festivo — `leave-redesign.spec.ts`.
95. `JPV-095` Editar un festivo y reflejarlo en calendario — `leave-redesign.spec.ts`.
96. `JPV-096` Eliminar un festivo — `leave-redesign.spec.ts`.
97. `JPV-097` Configurar comunidad, provincia y municipio — `labor-calendar.spec.ts`.
98. `JPV-098` Proponer festivos por ubicación y año — `labor-calendar.spec.ts`.
99. `JPV-099` Bloquear festivos ya existentes en la propuesta — `labor-calendar.spec.ts`.
100. `JPV-100` Importar sólo los festivos seleccionados — `labor-calendar.spec.ts`.

### Operaciones de RR. HH. del mismo ciclo

101. `JPV-101` Asignar una tarea y notificarla — `clocking.spec.ts`.
102. `JPV-102` Completar la tarea como empleado — `clocking.spec.ts`.
103. `JPV-103` Asignar un objetivo y notificarlo — `clocking.spec.ts`.
104. `JPV-104` Actualizar el progreso del objetivo — `clocking.spec.ts`.
105. `JPV-105` Alcanzar y mostrar el 100 % del objetivo — `clocking.spec.ts`.
106. `JPV-106` Crear una carpeta documental compartida — `document-folders.spec.ts`.
107. `JPV-107` Rechazar un documento sin título — `document-folders.spec.ts`.
108. `JPV-108` Publicar un documento para el empleado — `document-folders.spec.ts`.
109. `JPV-109` Confirmar la lectura del documento — `document-folders.spec.ts`.
110. `JPV-110` Mostrar la lectura al administrador — `document-folders.spec.ts`.
111. `JPV-111` Restringir carpetas por destinatarios y rol — `document-folders.spec.ts`.
112. `JPV-112` Impedir borrar una carpeta no vacía — `document-folders.spec.ts`.
113. `JPV-113` Enviar un gasto para aprobación — `clocking.spec.ts`.
114. `JPV-114` Aprobar el gasto como responsable — `clocking.spec.ts`.

### Cierre mensual, inspección y controles finales

115. `JPV-115` Cerrar desde la UI un mes terminado — `weekly-work-patterns.spec.ts`.
116. `JPV-116` Sumar los minutos planificados de todas las semanas variables — `weekly-work-patterns.spec.ts`.
117. `JPV-117` Conservar tipo de contrato parcial en el resumen — `weekly-work-patterns.spec.ts`.
118. `JPV-118` Separar minutos ordinarios, complementarios y extraordinarios — `weekly-work-patterns.spec.ts`.
119. `JPV-119` Rechazar horas complementarias sin pacto — `weekly-work-patterns.spec.ts`.
120. `JPV-120` Entregar un resumen inmutable, versionado y con huella — `compliance.spec.ts` y `weekly-work-patterns.spec.ts`.

### Inspección, retención e integraciones

121. `JPV-121` Descargar el CSV mensual con cabecera laboral — `weekly-work-patterns.spec.ts`.
122. `JPV-122` Incluir en CSV una fila por cada día natural del mes — `weekly-work-patterns.spec.ts`.
123. `JPV-123` Generar un Excel de inspección desde la UI — `weekly-work-patterns.spec.ts`.
124. `JPV-124` Incluir una hoja resumen en el Excel — `weekly-work-patterns.spec.ts`.
125. `JPV-125` Incluir una hoja por cada empleado, también inactivo — `monthly-inspection-vacation.spec.ts`.
126. `JPV-126` Mostrar planificado, trabajado y clasificación diaria en inspección — `weekly-work-patterns.spec.ts`.
127. `JPV-127` Incluir vacaciones y festivos en el ciclo inspeccionado — `monthly-inspection-vacation.spec.ts`.
128. `JPV-128` Aplicar una preservación legal a persona y periodo — `compliance.spec.ts`.
129. `JPV-129` Excluir datos preservados de la vista previa de purga — `compliance.spec.ts`.
130. `JPV-130` Liberar la preservación legal sin borrar registros — `compliance.spec.ts`.
131. `JPV-131` Crear y usar un token MCP de administración — `mcp.spec.ts`.
132. `JPV-132` Aislar los tokens de un responsable — `mcp.spec.ts`.
133. `JPV-133` Revocar un token e impedir reutilizarlo — `mcp.spec.ts`.
134. `JPV-134` Aplicar identidad corporativa al frontend y al manifiesto — `branding.spec.ts`.
135. `JPV-135` Servir manifiesto e iconos de PWA instalable — `pwa.spec.ts`.

## Cobertura adicional no contabilizada en el mínimo

- Confirmación de recepción sin presentarla como firma electrónica.
- Auditoría de cambios de cupos de ausencia.
- Bloqueo de referencias cruzadas entre organizaciones.

## Interpretación de «Cerrar y entregar»

En una jornada parcial variable, el cierre no debe tomar 8 horas por día ni
copiar las horas fichadas como si fueran planificación. Suma los minutos de los
planes aplicables a cada fecha del mes, aunque esos planes ya estén archivados,
y los contrasta con el registro efectivo. El resultado queda versionado e
inmutable y se pone a disposición del empleado. En modo planificado, si no hay
ningún horario aplicable al mes, el cierre lo indica expresamente y el
responsable debe completar el plan. En modo de cómputo semanal flexible no se
exigen franjas: el registro se contrasta con la cuota semanal y los días de
referencia se reservan para vacaciones y festivos.

Casos añadidos: cierre sin horarios de una semana flexible con distribución
diaria variable; clasificación del exceso semanal a tiempo completo; aceptación
de jornada parcial hasta la cuota sin pacto; mensaje específico cuando el modo
planificado no tiene ningún horario aplicable; y visualización del modo y sus
días de referencia en la UI de equipo.
