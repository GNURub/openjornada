# Política comercial y sistema de precios

> Estado: propuesta comercial inicial pendiente de validación con clientes.
> Última revisión: 25 de agosto de 2026.

Este documento define cómo presentar, calcular y revisar el precio de
OpenJornada. No constituye por sí solo una oferta contractual. Los importes sólo
deben anunciarse como disponibles cuando los precios de Stripe, la contratación,
la facturación y las condiciones comerciales estén configurados y probados.

## Principios

- OpenJornada se dirige inicialmente a pymes españolas de 1 a 100 personas.
- La métrica principal es la plantilla facturable, porque el valor y la carga de
  gestión aumentan con el número de trabajadores.
- El producto SaaS no tiene un plan gratuito. La alternativa gratuita para
  grupos de hasta diez trabajadores es la instalación propia permitida por la
  licencia vigente.
- Las funciones que sostienen el registro, la trazabilidad y la exportación no
  se limitan para forzar una mejora de plan.
- El precio debe ser público, comprensible y sin descuentos permanentes de
  adquisición.
- Todos los importes de este documento se expresan sin IVA.

## Definición de plantilla facturable

La plantilla declarada incluye empleados y contratistas de la persona, empresa
o grupo bajo control común, aunque no todos tengan cuenta en OpenJornada. En el
SaaS, la cantidad facturable es el mayor de estos dos valores:

1. La plantilla declarada en la suscripción.
2. El número de cuentas activas de la organización.

Una cuenta adicional nunca puede reducir la cantidad facturable. Las
reducciones de plantilla deben revisarse antes del siguiente ciclo y no deben
alterar registros históricos ni obligaciones de conservación.

## SaaS gestionado

El SaaS incluye alojamiento, actualizaciones, copias de seguridad operativas y
soporte estándar. La propuesta inicial es la siguiente:

| Plan | Plantilla | Precio mensual | Cálculo |
| --- | ---: | ---: | --- |
| Inicio | 1-10 | 29 € | Cuota fija |
| Crecimiento | 11-100 | 3 €/persona | Plantilla facturable × 3 € |
| Empresa | Más de 100 | Presupuesto | Contrato, soporte y requisitos específicos |

El paso de diez a once personas cambia la cuota mensual de 29 € a 33 €. No se
aplican tramos que provoquen saltos mayores ni se limita artificialmente el uso
para mantener una empresa en un plan inferior.

### Ejemplos

| Plantilla facturable | Mensual | Anual propuesto | Equivalente mensual anual |
| ---: | ---: | ---: | ---: |
| 10 | 29 € | 290 € | 24,17 € |
| 25 | 75 € | 750 € | 62,50 € |
| 50 | 150 € | 1.500 € | 125 € |
| 100 | 300 € | 3.000 € | 250 € |

### Pago anual

El pago anual propuesto equivale a diez mensualidades, con dos meses incluidos
por el compromiso anual. No debe implementarse como un cupón perpetuo.

La integración actual configura un precio Stripe por cada plan. Antes de
ofrecer pago anual deben existir precios recurrentes anuales diferenciados, una
selección inequívoca en Checkout y pruebas de renovación, cambio de plan,
cancelación y prorrateo. Hasta entonces sólo debe anunciarse la modalidad
mensual.

### Prueba

- Duración: 14 días.
- Sin tarjeta de pago.
- Acceso funcional suficiente para configurar una empresa, registrar jornadas
  reales y generar un primer informe.
- La prueba no elimina las comprobaciones de identidad, aislamiento, permisos o
  conservación.

## Programa Empresas Fundadoras

La oferta de lanzamiento se limita a las primeras veinte empresas de pago y
debe cerrarse cuando se alcance esa cifra. Puede limitarse además a cuatro
puestas en marcha mensuales si esa es la capacidad real de acompañamiento.

Incluye:

- Configuración asistida de calendarios, horarios y políticas.
- Importación inicial de hasta cincuenta trabajadores.
- Una sesión de formación para administración.
- Revisión conjunta del primer informe mensual o de inspección.
- Soporte prioritario durante los primeros sesenta días.
- Precio protegido durante veinticuatro meses.
- Canal directo para aportar feedback de producto.

La suscripción no se rebaja. La oferta reduce el esfuerzo y el riesgo de la
puesta en marcha sin anclar OpenJornada como un producto barato.

### Garantía de puesta en marcha

El plazo empieza en la fecha posterior entre el cobro de la primera mensualidad
y la recepción completa de la información de onboarding, confirmada por
escrito. Desde ese momento, si en catorce días el equipo no puede registrar
jornada y descargar un primer informe por una causa atribuible a OpenJornada,
la empresa puede elegir entre:

- El reembolso de la primera mensualidad abonada.
- La continuación de la configuración asistida sin coste hasta alcanzar esos
  dos hitos.

La garantía no promete cumplimiento jurídico automático, ausencia de sanciones
ni resultados que dependan de políticas, convenios o actuaciones de la empresa.

## Instalación propia y licencia comercial

La instalación propia y el SaaS son ofertas distintas:

- Hasta diez trabajadores, el uso productivo autogestionado es gratuito según
  la Business Source License vigente. La empresa asume infraestructura,
  actualizaciones, copias y operación.
- Desde once trabajadores se necesita una licencia comercial o permiso previo
  por escrito, aunque la instalación sea propia.

Hipótesis inicial para la licencia comercial autogestionada:

| Plantilla del grupo | Licencia anual | Incluye |
| --- | ---: | --- |
| 11-50 | 750 € | Derecho de uso comercial y actualizaciones publicadas durante la vigencia |
| 51-100 | 1.250 € | Derecho de uso comercial y actualizaciones publicadas durante la vigencia |
| Más de 100 | Presupuesto | Condiciones, soporte y alcance acordados por escrito |

La instalación, migración, soporte con SLA y desarrollos específicos no están
incluidos. Como referencia inicial, una puesta en marcha gestionada puede
ofrecerse desde 900 €, siempre mediante alcance y presupuesto separados.

Estos importes no deben publicarse como oferta contractual hasta disponer de
un contrato comercial que defina vigencia, versiones cubiertas, soporte,
responsabilidad, renovación y terminación.

## Referencia competitiva

La referencia se usa para situar el precio, no para copiar el modelo de otro
producto. Los precios se consultaron en las páginas oficiales el 25 de agosto
de 2026 y pueden cambiar.

| Competidor | Precio público observado | Condición destacada |
| --- | ---: | --- |
| [Woffu](https://woffu.com/es/precios-woffu/) | Desde 1,50 €/usuario/mes | Lite para un máximo de diez empleados |
| [Bixpe](https://bixpe.com/control-horario/) | Gratis o 2 €/usuario/mes | El plan gratuito limita el histórico; Premium conserva cuatro años |
| [Control Laboral](https://controllaboral.es/precios/) | Desde 19,90 €/mes el primer año | Precio normal y puesta en marcha separados |
| [Factorial](https://factorial.es/plan-de-precios) | Desde 5,50 €/persona/mes | Paquetes personalizados y módulos adicionales |
| [Sesame HR](https://www.sesamehr.es/precio/) | 5,25-9 €/empleado/mes | Mínimo de contratación de quince empleados |
| [Bizneo HR](https://www.bizneo.com/pricing/) | Desde 6 €/empleado/mes | Suite modular e implantación asistida |

OpenJornada se posiciona entre las herramientas básicas de fichaje, situadas
aproximadamente entre 1,50 € y 2 € por persona, y las suites de RR. HH., que
parten aproximadamente de 5,25 € a 6 € por persona. El precio inicial de 3 €
compensa la falta de referencias comerciales sin competir exclusivamente por
ser la opción más barata.

## Validación durante los primeros 90 días

El precio inicial es una hipótesis que debe generar aprendizaje verificable:

1. Entrevistar al menos a quince pymes o gestorías y presentarles el precio
   real, no sólo preguntar cuánto pagarían.
2. Mantener el mismo precio durante las primeras diez pruebas con datos reales.
3. Registrar activación, tiempo hasta el primer fichaje e informe, conversión a
   pago, horas de soporte y motivo de no contratación.
4. Realizar una revisión obligatoria al cumplirse noventa días, aunque todavía
   no existan cinco clientes de pago.
5. Realizar otra revisión al alcanzar cinco clientes de pago, antes o después
   del día noventa.

Reglas de decisión iniciales:

- Si el precio apenas genera objeciones y la conversión es sólida, probar con
  nuevos prospectos un mínimo de 35 € y 3,50 € por persona.
- Si las empresas se activan pero no contratan, revisar precio, oferta y
  posicionamiento antes de añadir más planes.
- Si no alcanzan el primer fichaje e informe, mejorar el onboarding antes de
  reducir el precio.
- Si el soporte supera de forma recurrente dos horas por empresa y mes, revisar
  el mínimo, el alcance incluido o el proceso de puesta en marcha.

No se deben presentar estas reglas como benchmarks del mercado: son umbrales
operativos internos para tomar decisiones consistentes.

## Correspondencia técnica

La política propuesta aprovecha los planes existentes:

| Código interno | Uso comercial previsto | Facturación |
| --- | --- | --- |
| `starter-fixed` | Inicio, hasta diez personas | Cuota fija mensual |
| `growth-tiered` | Crecimiento, de once a cien personas | Cantidad facturable × precio unitario |
| `managed-manual` | Empresa, licencias y acuerdos especiales | Gestión manual y contrato |

La tabla describe el comportamiento comercial objetivo, no una restricción
que el sistema aplique actualmente. A fecha de esta propuesta,
`growth-tiered` conserva un límite técnico ilimitado y el alta pública no
impide contratarlo con menos de once o más de cien personas. Por tanto, esta
política no debe activarse ni anunciarse como automatizada hasta que una futura
implementación valide los tramos Inicio (1–10), Crecimiento (11–100) y derive
los casos de más de cien personas a gestión manual. Ese cambio deberá incluir
la migración, las validaciones de servidor y las pruebas correspondientes.

Los importes no deben escribirse en migraciones publicadas ni en el código. Los
identificadores de precio se configuran mediante secretos de despliegue. Antes
de activar `PB_BILLING_ENABLED=true`, deben probarse Checkout, Customer Portal,
webhooks, cambios de cantidad, impagos y restauración del acceso conforme a
`docs/DEPLOYMENT.md`.

## Gobierno de cambios

- Revisar esta política trimestralmente durante el primer año.
- Fechar cada comparación de mercado y no conservar importes obsoletos como si
  siguieran vigentes.
- Probar aumentos primero con nuevos clientes.
- Comunicar cambios a clientes existentes con antelación y una transición
  definida; no prometer precios vitalicios.
- Documentar por separado cualquier excepción comercial.
- Mantener una única dirección comercial: [hello@di-seo.com](mailto:hello@di-seo.com).
