# Diseño de licencia comercial para OpenJornada

Fecha: 2026-08-24

## Objetivo

Publicar OpenJornada bajo un modelo de código disponible que permita el uso
productivo gratuito a grupos empresariales pequeños y requiera una licencia
comercial o permiso escrito cuando se supere el umbral. El cambio debe ser
claro para quienes instalan el proyecto, no debe introducir bloqueos técnicos
y debe conservar la posibilidad de relicenciar contribuciones futuras.

Este documento define la implementación técnica y documental. No sustituye la
revisión de un profesional jurídico ni constituye por sí mismo un contrato
comercial.

## Modelo elegido

OpenJornada utilizará Business Source License 1.1 (`BUSL-1.1`) con una
concesión adicional de uso productivo. BSL 1.1 permite parametrizar el
licenciante, la obra, el uso productivo adicional, la fecha de cambio y la
licencia open source posterior sin modificar el resto de su texto oficial.

El proyecto dejará de describirse como «software libre» u «open source» antes
de la fecha de cambio. Se describirá como software con código disponible y
licencia dual. La restricción por tamaño de empresa es incompatible con la
definición de open source de la OSI.

Referencias:

- [Business Source License 1.1](https://mariadb.com/bsl11/)
- [Identificador SPDX BUSL-1.1](https://spdx.org/licenses/BUSL-1.1.html)
- [Open Source Definition](https://opensource.org/osd)
- [GNU Affero GPL para software de red](https://www.gnu.org/licenses/why-affero-gpl.html)

## Parámetros de BSL 1.1

- **Licenciante:** Rubén Cid Lara.
- **Obra licenciada:** OpenJornada, salvo los componentes de terceros que
  indiquen expresamente otra licencia.
- **Concesión adicional:** se permite el uso productivo cuando el licenciatario
  y todas las entidades bajo control común tienen, conjuntamente, un máximo de
  diez trabajadores.
- **Trabajador:** toda persona empleada o contratista independiente que preste
  servicios a cualquiera de esas entidades. No depende de que tenga una cuenta
  en OpenJornada.
- **Uso por encima del umbral:** con once o más trabajadores requiere una
  licencia comercial o permiso previo por escrito del licenciante.
- **Contacto comercial:** `rubencidlara@gmail.com`.
- **Fecha de cambio inicial:** 2030-08-24.
- **Licencia de cambio:** GNU Affero General Public License version 3 or any
  later version (`AGPL-3.0-or-later`).

El bloque de concesión adicional se redactará en inglés para integrarse sin
ambigüedad con el texto oficial de BSL. La concesión sólo ampliará el uso
productivo permitido por BSL; no modificará ni añadirá restricciones al cuerpo
estándar de la licencia.

Cada versión de OpenJornada se licencia por separado. La documentación de
publicación indicará que la fecha de cambio debe revisarse en cada nueva
versión y nunca podrá superar cuatro años desde su primera distribución
pública bajo BSL. No se reescribirán etiquetas históricas: el nuevo régimen se
aplicará a las revisiones y versiones que incluyan el archivo `LICENSE`.

## Archivos legales y documentación

La implementación añadirá:

- `LICENSE`, con los parámetros anteriores y el texto oficial íntegro de BSL
  1.1.
- `NOTICE`, con el copyright de Rubén Cid Lara, el alcance de la licencia y la
  exclusión de materiales de terceros sujetos a sus propias condiciones.
- `COMMERCIAL-LICENSE.md`, como explicación operativa en español del umbral,
  ejemplos, preguntas frecuentes y canal de contacto. No contendrá ni simulará
  un contrato comercial definitivo.
- `CONTRIBUTING.md`, indicando que se aceptan incidencias y propuestas, pero no
  se fusionarán contribuciones con contenido sujeto a copyright sin aceptar
  previamente un acuerdo de contribución que permita su relicenciamiento.

También se actualizarán:

- `README.md`, eliminando el aviso de que el proyecto carece de licencia y
  explicando el uso gratuito, el uso comercial y el cambio futuro a AGPL.
- `web/package.json`, con el identificador SPDX `BUSL-1.1`.
- `docs/FEATURES.md`, para documentar el aviso no bloqueante de la interfaz.
- La documentación de publicación existente, con la comprobación manual de la
  fecha de cambio para cada nueva versión.

Las licencias ya incluidas en `firmware/terminal/LICENSES/` y cualquier otro
aviso de terceros se conservarán sin cambios y prevalecerán para sus materiales
respectivos.

## Aviso en la aplicación

La aplicación no impondrá un bloqueo técnico ni validará claves comerciales en
esta fase. La licencia es la autoridad contractual; el recuento local es sólo
una ayuda informativa.

Se creará una función de dominio pura que:

1. filtre las cuentas activas de la organización;
2. calcule su cantidad; y
3. indique que se debe mostrar el aviso al alcanzar once cuentas activas.

Un componente standalone compartido presentará el aviso en las vistas
**Equipo** y **Ajustes**. Sus propiedades serán:

- visible únicamente para roles `admin` y `manager`;
- persistente y no descartable;
- sin impedir altas, activaciones, fichajes ni ninguna otra operación;
- accesible mediante una región etiquetada y texto comprensible;
- muestra el número de cuentas activas detectadas;
- aclara que la definición contractual cuenta también empleados y
  contratistas del grupo que no estén dados de alta;
- incluye un enlace `mailto:` a `rubencidlara@gmail.com` con un asunto
  predefinido para solicitar licencia o permiso;
- desaparece cuando el recuento vuelve a diez o menos.

La vista Equipo ya obtiene los registros completos. Ajustes ampliará su
selección de campos de usuarios para incluir `active`. No se añadirán
migraciones, endpoints, telemetría, almacenamiento de estado comercial ni
dependencias externas.

## Contribuciones y capacidad de relicenciamiento

El historial actual sólo identifica a Rubén Cid Lara como autor, y el
repositorio aún no contiene una licencia raíz. Antes de aceptar código externo,
el mantenedor deberá contar con un CLA aceptado expresamente que otorgue los
derechos necesarios para ofrecer el proyecto bajo BSL y bajo licencias
comerciales separadas.

Esta fase documentará la política, pero no creará un servicio automatizado de
CLA. Hasta disponer del acuerdo y de su registro, los pull requests con
contenido sujeto a copyright no se fusionarán. Los informes de errores y las
propuestas sin código podrán continuar por los canales habituales.

## Pruebas y verificación

La implementación incluirá:

- pruebas unitarias del cálculo con cero, diez y once cuentas activas;
- pruebas que excluyan cuentas inactivas;
- pruebas del componente compartido, su contenido, accesibilidad y enlace
  comercial;
- un recorrido Playwright que verifique la visibilidad para administración o
  responsables y la ausencia del aviso para empleados;
- revisión de que el texto de licencia sea el oficial y de que el identificador
  SPDX sea coherente;
- `pnpm run test:ci`;
- `pnpm run build`;
- `pnpm run e2e`;
- `git diff --check` y revisión independiente antes de integrar.

## Fuera de alcance

Esta fase no incluye:

- emisión, firma o validación de claves comerciales;
- bloqueo de la aplicación o limitación de altas;
- telemetría o comunicación del número de trabajadores al licenciante;
- precios, facturación, soporte contratado o condiciones del futuro contrato
  comercial;
- automatización del CLA;
- aplicación retroactiva a etiquetas históricas;
- asesoramiento jurídico profesional.

## Criterios de aceptación

El cambio se considera completo cuando la versión que lo contiene ofrece el
texto oficial BSL 1.1 con los parámetros acordados, explica de forma coherente
el modelo dual, conserva los avisos de terceros, impide mediante la política de
contribución que se incorporen derechos incompatibles y muestra el aviso no
bloqueante a administración y responsables al detectar once cuentas activas.
Todas las verificaciones indicadas deben finalizar correctamente.
