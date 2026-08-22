# Diseño de aprovisionamiento de terminal mediante QR

## Objetivo

Permitir que una persona administradora genere desde **Integraciones** un QR
de un solo uso con todos los datos necesarios para aprovisionar una terminal
M5Stack: SSID, contraseña Wi-Fi, URL de OpenJornada y API key `ojterm_…`.
Después de conectar el móvil al punto de acceso de la terminal, la cámara
nativa abre el portal local y autocompleta esos cuatro campos. El formulario
manual actual permanece siempre disponible.

El QR reduce errores de transcripción sin convertir OpenJornada en almacén de
credenciales Wi-Fi ni relajar la validación final del terminal.

## Contexto actual

- Integraciones crea o rota una credencial independiente por terminal y sólo
  muestra el valor completo una vez.
- El backend conserva únicamente la representación necesaria para autenticar
  la credencial; no puede recuperar la API key original.
- Cuando falta configuración, el M5Stack publica un punto de acceso WPA2 y un
  portal cautivo en `http://192.168.4.1/`.
- El portal solicita manualmente SSID, contraseña Wi-Fi, URL base y API key.
- El M5Stack Basic Core v2.7 no tiene cámara. La captura del QR corresponde a
  la cámara nativa del móvil.
- El portal cautivo usa HTTP local. Las APIs de cámara dentro del navegador no
  son suficientemente compatibles en ese contexto, especialmente en los
  navegadores cautivos de iOS y Android.

## Alcance

La entrega incluye:

- generación local de un QR al crear o rotar una API key de terminal;
- entrada efímera de SSID y contraseña Wi-Fi en Integraciones;
- URL de OpenJornada precargada con el origen actual y editable;
- QR ampliable para facilitar su lectura desde otra pantalla;
- apertura del portal mediante un enlace con fragmento y autocompletado;
- formulario manual como alternativa permanente;
- controles accesibles para mostrar u ocultar la contraseña Wi-Fi y la API
  key en el portal;
- validación de versión, tipos, codificación y límites antes de autocompletar;
- eliminación inmediata del fragmento de la barra de direcciones y del
  historial actual;
- pruebas unitarias, E2E y aceptación física en la placa real;
- documentación funcional, de seguridad y del firmware.

Quedan fuera:

- almacenar o sincronizar perfiles Wi-Fi en PocketBase;
- regenerar un QR después de cerrar la vista de secreto;
- leer el QR con el propio M5Stack;
- depender de una API de cámara dentro del portal cautivo;
- enviar automáticamente el formulario tras escanear;
- descargar o archivar el QR como credencial permanente;
- incluir en el QR la contraseña temporal del punto de acceso del M5Stack,
  que se genera localmente en cada apertura del portal.

## Flujo de usuario

### Generación en Integraciones

1. Administración crea una terminal o rota su API key.
2. La UI conserva la API key completa sólo en memoria, como hace actualmente.
3. En el mismo bloque de un solo uso solicita:
   - SSID;
   - contraseña Wi-Fi;
   - URL de OpenJornada, precargada con `window.location.origin` y editable.
4. La UI valida los límites y genera el QR enteramente en el navegador.
5. El bloque ofrece:
   - QR ampliable;
   - API key enmascarada con mostrar/ocultar;
   - contraseña Wi-Fi enmascarada con mostrar/ocultar;
   - copia explícita de la API key;
   - una advertencia de que el QR contiene credenciales completas.
6. Al cerrar el bloque, navegar fuera, crear otra terminal o rotar otra key,
   la UI elimina de memoria API key, contraseña y contenido del QR.
7. Para obtener otro QR es obligatorio rotar la API key e introducir otra vez
   los datos Wi-Fi.

El SSID, la contraseña Wi-Fi y el payload QR no se envían a PocketBase, a
telemetría, a logs ni a almacenamiento del navegador.

### Aplicación en el terminal

1. El M5Stack muestra su QR WPA2 habitual para conectar el móvil al AP
   `OpenJornada-XXXX`.
2. Con el móvil ya conectado al AP, la persona escanea desde la cámara nativa
   el QR mostrado en Integraciones en otra pantalla.
3. La cámara abre `http://192.168.4.1/#ojp=…`.
4. El portal carga el recurso JavaScript local, decodifica y valida el
   fragmento.
5. Si es válido, rellena SSID, contraseña, URL y API key.
6. El portal sustituye la entrada actual del historial por
   `http://192.168.4.1/`, de modo que el fragmento deje de verse y no quede en
   esa entrada del historial.
7. La persona revisa los datos y pulsa **Comprobar y guardar**.
8. El firmware aplica sus validaciones C++ actuales, conecta, ejecuta
   `bootstrap` y sólo entonces persiste la configuración.

El escaneo nunca equivale a confirmar. Un payload válido sólo autocompleta.

## Contrato QR v1

El valor codificado es una URL HTTP local:

```text
http://192.168.4.1/#ojp=<payload-base64url>
```

`payload-base64url` representa en Base64 URL-safe, sin padding, los bytes
UTF-8 de este JSON compacto y canónico:

```json
{
  "v": 1,
  "s": "Red del negocio",
  "p": "contraseña Wi-Fi",
  "u": "https://jornada.example.com",
  "t": "ojterm_…"
}
```

Campos:

| Campo | Tipo | Significado | Límite |
| --- | --- | --- | --- |
| `v` | entero | Versión exacta del contrato | `1` |
| `s` | cadena UTF-8 | SSID | 32 bytes |
| `p` | cadena UTF-8 | Contraseña Wi-Fi | 63 bytes |
| `u` | cadena ASCII/URL | URL base de OpenJornada | 255 bytes |
| `t` | cadena ASCII | API key del terminal | 96 bytes y prefijo `ojterm_` |

El objeto debe contener exactamente esas cinco propiedades en el orden
`v,s,p,u,t`, sin espacios ni valores adicionales. Tras parsearlo, el decoder
lo vuelve a serializar en ese orden y exige igualdad byte a byte con el JSON
recibido. De este modo rechaza también claves duplicadas, orden alternativo y
representaciones ambiguas. Además rechaza Base64 inválido, UTF-8 inválido,
JSON no objetual, tipos incorrectos, versión desconocida, `s`, `u` o `t`
vacíos y límites excedidos. `p` puede estar vacío para una red abierta.

El portal realiza una validación temprana de URL y prefijo para ofrecer un
mensaje útil. La política definitiva continúa en C++ y depende del perfil:

- `m5stack_release`: sólo HTTPS;
- `m5stack_dev`: HTTP únicamente bajo la excepción privada ya documentada.

El QR usa corrección de errores **M**, margen de cuatro módulos y una anchura
visual mínima de 320 píxeles al ampliarlo. La URL QR completa no puede superar
600 bytes ASCII. Si los campos son válidos para el terminal pero exceden ese
umbral, Integraciones no genera el símbolo, muestra una advertencia y conserva
copia y entrada manual como alternativas.

## Diseño del frontend

### Codec

Un codec pequeño y puro es responsable de:

- validar los campos con medición real de bytes UTF-8;
- serializar únicamente las claves compactas v1 en orden estable;
- convertir UTF-8 a Base64 URL-safe sin padding;
- construir la URL local;
- impedir la generación cuando la URL codificada supera 600 bytes.

El codec no conoce PocketBase, componentes ni almacenamiento.

### Estado efímero

El componente de Integraciones conserva por separado:

- la API key recién emitida;
- los campos locales de Wi-Fi y URL;
- el valor QR derivado;
- el estado visual de revelar/ocultar.

Ninguno de esos datos se incluye al listar terminales ni se reconstruye desde
registros existentes. La creación y rotación siguen recibiendo la API key una
sola vez; cerrar el bloque ejecuta un borrado explícito de todas las señales
efímeras.

### Presentación

- Los secretos se muestran en campos `type="password"` por defecto.
- Cada ojo es un botón `type="button"` con nombre accesible dinámico,
  `aria-pressed` y foco visible.
- El QR tiene texto alternativo que no contiene secretos.
- La ampliación se cierra por botón, Escape y retorno de foco.
- No se ofrece descarga automática del QR.
- Copiar la API key requiere una acción explícita y mantiene los mensajes
  españoles existentes.

La librería de generación QR se fija a una versión exacta, se ejecuta sólo en
el cliente y se incluye en `pnpm audit --prod`.

## Diseño del portal del firmware

### Recurso estático

La lógica del navegador vive en un archivo JavaScript auditable y sin
dependencias remotas. PlatformIO lo incorpora como recurso de texto en las
compilaciones ESP32 y el portal lo sirve desde `/provisioning.js` con:

```text
Content-Type: application/javascript; charset=utf-8
Cache-Control: no-store, max-age=0
X-Content-Type-Options: nosniff
```

El HTML carga sólo ese recurso local. La CSP se limita a:

```text
default-src 'none'; style-src 'unsafe-inline'; script-src 'self';
form-action http://192.168.4.1; base-uri 'none'; frame-ancestors 'none'
```

No se habilitan scripts inline ni dominios externos.

### Responsabilidades del script

- leer exclusivamente `location.hash` con prefijo `#ojp=`;
- decodificar Base64 URL-safe y UTF-8 de forma estricta;
- validar el esquema v1 antes de modificar cualquier campo;
- aplicar los cuatro valores de forma atómica;
- limpiar el fragmento mediante `history.replaceState`;
- mostrar un error español genérico sin reproducir el contenido rechazado;
- controlar los ojos de contraseña Wi-Fi y API key;
- no enviar peticiones adicionales, no usar almacenamiento y no generar logs.

El script no pulsa el submit ni evita que el usuario edite cualquier campo.

### Formulario y servidor

El formulario POST y su CSRF permanecen iguales. Los valores autocompletados
recorren exactamente `decodeProvisioningFormRequest`, `validateDeviceConfig`,
la conexión Wi-Fi, `bootstrap` y `ConfigStore::save`. El servidor no recibe el
fragmento porque los navegadores no incluyen esa parte en HTTP.

Las rutas cautivas desconocidas siguen redirigiendo a `/`. La nueva ruta del
script se resuelve antes de la redirección y sólo admite GET.

## Seguridad y privacidad

El QR contiene credenciales en texto recuperable. Base64 es transporte, no
cifrado. Cualquier persona capaz de verlo o fotografiarlo puede obtener acceso
a la red Wi-Fi y actuar como el terminal hasta que la API key sea revocada.

Controles obligatorios:

- generación sólo tras crear o rotar una key;
- advertencia visible antes y junto al QR;
- secretos enmascarados por defecto;
- ausencia de persistencia cliente y servidor;
- `Cache-Control: no-store` en portal, script y respuestas sensibles;
- fragmento, nunca query ni path;
- limpieza inmediata del fragmento tras validación;
- ningún secreto en mensajes, logs, analítica, atributos accesibles o texto
  alternativo;
- confirmación manual antes de guardar;
- posibilidad inmediata de rotar o revocar la API key.

La limpieza de memoria en JavaScript es de mejor esfuerzo: el runtime puede
copiar cadenas internamente. La garantía de seguridad es no persistirlas ni
transmitirlas fuera del flujo, no prometer borrado criptográfico de RAM.

## Errores y recuperación

- QR ausente: se muestra el formulario manual normal.
- QR válido: se autocompletan todos los campos y aparece un aviso de revisión.
- QR inválido o incompleto: no se cambia ningún campo y se muestra
  **No se pudo leer la configuración del QR. Introduce los datos manualmente.**
- Versión desconocida: mismo comportamiento seguro, sin intentar compatibilidad
  parcial.
- URL QR superior a 600 bytes: Integraciones no crea el símbolo y conserva
  copia y formulario manual.
- API key cerrada antes de generar el QR: la UI exige rotarla; nunca intenta
  recuperarla del backend.
- Fallo Wi-Fi o `bootstrap`: se conserva el comportamiento actual y se vuelve
  a mostrar el acceso del portal sin guardar el candidato.

## Pruebas

### Frontend unitario

- vector exacto v1 con SSID ASCII;
- UTF-8 en SSID y contraseña medido por bytes;
- Base64 URL-safe sin padding;
- orden estable de claves;
- límites exactos y un byte por encima;
- URL y token inválidos;
- URL QR de 600 bytes aceptada y de 601 bytes rechazada;
- limpieza de señales al cerrar, navegar, crear o rotar otra terminal;
- demostrar que editar SSID/contraseña no realiza peticiones ni escrituras de
  almacenamiento;
- ojos accesibles, enmascarados por defecto y sin submit accidental.

### Contrato del script del portal

El archivo JavaScript real incorporado al firmware se carga en un navegador
de prueba. Se verifican:

- vector compartido con el codec Angular;
- fragmento válido y autocompletado atómico;
- limpieza con `history.replaceState`;
- no envío automático;
- Base64, UTF-8, JSON, claves, tipos, versión y límites inválidos;
- campos manuales intactos tras cualquier error;
- controles mostrar/ocultar y etiquetas accesibles;
- ausencia de `localStorage`, `sessionStorage`, cookies, red adicional y logs.

### E2E Angular

- crear terminal, introducir datos locales y generar QR;
- cerrar y comprobar que no puede regenerarse;
- rotar la key y obtener un QR nuevo;
- verificar que los listados nunca exponen Wi-Fi ni token completo;
- comprobar el aviso de seguridad, ampliación y navegación por teclado.

### Firmware y hardware

- pruebas nativas existentes del parser y la política URL;
- build `m5stack_dev` y `m5stack_release` con el recurso embebido;
- comprobación de cabeceras CSP y `no-store`;
- flasheo físico;
- conexión móvil al AP mediante el QR de la pantalla;
- lectura del QR de Integraciones con cámara nativa;
- revisión del autocompletado y de ambos ojos;
- `bootstrap` en demo privada con development;
- repetición release contra HTTPS;
- formulario manual válido después de un QR inválido.

Antes de entregar deben pasar `pnpm run build`, `pnpm run test:ci`, el E2E
afectado, `pnpm audit --prod`, todas las pruebas nativas y ambos builds ESP32.

## Documentación

La entrega actualiza:

- `docs/FEATURES.md`: aprovisionamiento QR y alternativa manual;
- `docs/COMPLIANCE_ES.md`: exposición y custodia del QR con secretos;
- `firmware/terminal/README.md`: recorrido exacto con cámara nativa, fallback
  manual y perfiles dev/release;
- `README.md` si cambia el recorrido general de puesta en servicio.

## Compatibilidad y despliegue

- Las terminales configuradas y los portales abiertos manualmente siguen
  funcionando sin migración.
- Un firmware anterior ignora el fragmento y muestra el formulario manual; no
  recibe secretos por HTTP.
- El contrato lleva versión para permitir una evolución futura sin aceptar
  interpretaciones parciales.
- La nueva UI sólo ofrece QR cuando dispone de una API key completa recién
  creada o rotada.
- No se modifica la API backend ni el esquema PocketBase.

La aceptación final exige demostrar el recorrido real en un móvil y la placa
M5Stack conectada, además de conservar el formulario manual y las restricciones
de seguridad de producción.
