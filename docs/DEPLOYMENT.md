# Despliegue de OpenJornada

Esta guía cubre un despliegue de un único nodo con Docker Compose y un proxy
HTTPS. Para alta disponibilidad hacen falta almacenamiento compartido, una
estrategia de consistencia y pruebas adicionales; PocketBase no debe escalarse
horizontalmente copiando el mismo volumen entre contenedores.

## Requisitos

- Servidor Linux con Docker 26+ y Compose 2.26+.
- DNS apuntando al servidor.
- Proxy inverso con certificados TLS.
- Almacenamiento persistente y copias externas cifradas.
- Servidor SMTP para recuperación y verificación de cuentas.

La imagen instala la base IANA `tzdata`. Es necesaria para interpretar
`PB_TIMEZONE` y las zonas horarias configuradas por empresa, incluidos los
cambios de horario de verano; no debe eliminarse al endurecer la imagen.

Antes de publicar cada versión:

1. fija en `LICENSE` una `Change Date` que no supere cuatro años desde la
   primera distribución pública bajo BSL de esa versión;
2. conserva `AGPL-3.0-or-later` como `Change License`, salvo una decisión legal
   documentada compatible con las condiciones de BSL 1.1;
3. verifica que la etiqueta publicada contiene `LICENSE`, `NOTICE`,
   `THIRD_PARTY_NOTICES` y los avisos de terceros;
4. construye la imagen y comprueba documentalmente el artefacto final:

   ```bash
   docker build -t openjornada:license-audit .
   docker run --rm --entrypoint sh openjornada:license-audit -c \
     'test -s /app/LICENSE && test -s /app/NOTICE && \
      test -s /app/THIRD_PARTY_NOTICES && \
      test -s /app/licenses/FRONTEND_THIRD_PARTY_LICENSES.txt && \
      test -s /app/licenses/GO_THIRD_PARTY_LICENSES.txt'
   ```

El informe del frontend procede del bundle de producción real de Angular. El
informe Go se genera desde los módulos que `go list -deps` confirma enlazados en
el binario, no desde todas las entradas posibles de `go.mod`.

## Imágenes publicadas en GitHub

El workflow
[`publish-container.yml`](../.github/workflows/publish-container.yml) se ejecuta
cuando una Release de GitHub pasa al estado `published`. La etiqueta de la
release debe ser una versión semántica, por ejemplo `v1.4.2` o
`v1.5.0-rc.1`.

El workflow:

- autentica en `ghcr.io` con el `GITHUB_TOKEN` efímero del workflow;
- construye un único manifiesto para `linux/amd64` y `linux/arm64`;
- publica en `ghcr.io/gnurub/openjornada`;
- incorpora etiquetas OCI, SBOM y una attestación de procedencia;
- utiliza caché de GitHub Actions sin incluir `.env`, datos persistentes ni
  artefactos ignorados por `.dockerignore`.

Para una release estable `v1.4.2` se publican:

```text
ghcr.io/gnurub/openjornada:1.4.2
ghcr.io/gnurub/openjornada:1.4
ghcr.io/gnurub/openjornada:1
ghcr.io/gnurub/openjornada:latest
ghcr.io/gnurub/openjornada:sha-<commit-completo>
```

Las prereleases sólo reciben la versión completa y la etiqueta `sha-*`; no
modifican `latest`, ni las etiquetas mayor y menor. Para descargar una versión:

```bash
docker pull ghcr.io/gnurub/openjornada:1.4.2
docker image inspect ghcr.io/gnurub/openjornada:1.4.2
```

El workflow declara únicamente los permisos `contents: read`, `packages: write`,
`attestations: write` e `id-token: write`; no necesita un token personal. Tras
la primera publicación, revisa en la configuración del paquete de GitHub su
visibilidad y el acceso heredado del repositorio. Para producción fija una
versión exacta o un digest `sha256`; no dependas de `latest` para despliegues
reproducibles.

## Publicación de la CLI del terminal

El workflow
[`publish-terminal-cli.yml`](../.github/workflows/publish-terminal-cli.yml) se
ejecuta al publicar cualquier Release de GitHub, tanto estable como prerelease.
Obtiene el código de la etiqueta exacta de la release, sin conservar
credenciales de Git en el checkout, y usa la versión de Go declarada por
`cli/openjornada-terminal/go.mod`. Antes de publicar ejecuta las pruebas, `go
vet` y seis compilaciones con `CGO_ENABLED=0` para Linux, macOS y Windows en
arquitecturas amd64 y arm64.

Cada binario incorpora la etiqueta, el commit y la fecha de publicación de la
release. Los paquetes son reproducibles y contienen exclusivamente el binario,
`LICENSE`, `NOTICE` y `THIRD_PARTY_NOTICES`. La release recibe este inventario:

```text
openjornada-terminal_linux_amd64.tar.gz
openjornada-terminal_linux_arm64.tar.gz
openjornada-terminal_darwin_amd64.tar.gz
openjornada-terminal_darwin_arm64.tar.gz
openjornada-terminal_windows_amd64.zip
openjornada-terminal_windows_arm64.zip
checksums.txt
install.sh
install.ps1
```

El job de compilación sólo dispone de `contents: read` y entrega los seis
paquetes mediante un artefacto de Actions retenido durante un día. Un job
aislado genera el inventario SHA-256, incorpora los instaladores, verifica que
no falte ni sobre ningún asset y crea attestaciones para los seis paquetes y
`checksums.txt`. Sólo ese job declara `contents: write`, `attestations: write` e
`id-token: write`. Después de subir los nueve archivos vuelve a consultar sus
nombres y tamaños en GitHub y falla si falta alguno, está duplicado o tiene
tamaño cero.

Las prereleases reciben el mismo conjunto de assets y attestaciones, pero
GitHub no las resuelve mediante `releases/latest`; por ello los instaladores que
usan ese endpoint continúan apuntando a la última release estable. Si una
publicación falla, corrige la etiqueta o el contenido y vuelve a ejecutar el
workflow: no publiques paquetes construidos desde otra revisión ni sustituyas
el `GITHUB_TOKEN` efímero por un token personal.

## Prueba local de un terminal RFID físico

El firmware debe usar la IP LAN del ordenador que ejecuta OpenJornada, por
ejemplo `http://192.168.1.20:8090`. No configures `127.0.0.1`: desde el M5Stack
esa dirección apunta al propio dispositivo, no al ordenador.

El backend sólo admite HTTP por LAN cuando las dos variables siguientes valen
`true`, el host solicitado es una dirección RFC1918 y el peer remoto también es
privado o local:

```dotenv
PB_DEMO_ENABLED=true
PB_TERMINAL_DEV_INSECURE_HTTP=true
```

Esta excepción está prohibida en producción. En cualquier despliegue real usa
HTTPS y fija ambas variables en `false`. La excepción no publica ni autoriza el
panel PocketBase `/_/`; mantenlo sin exposición pública y restringido a
administración.

Compila y flashea por USB desde `firmware/terminal/`:

```bash
python3 -m unittest scripts/test_validate_partitions.py scripts/test_release_firmware.py
uv tool run --from platformio==6.1.19 platformio test -e native -f test_usb_protocol
uv tool run --from platformio==6.1.19 platformio test -e native
uv tool run --from platformio==6.1.19 platformio run -e m5stack_dev --target upload --upload-port /dev/ttyACM0
uv tool run --from platformio==6.1.19 platformio device monitor --port /dev/ttyACM0 --baud 115200
uv tool run --from platformio==6.1.19 platformio run -e m5stack_release
```

La release sólo admite HTTPS y usa el bundle de CA del firmware. La primera
instalación de firmware 1.2.0 se hace por USB para activar los slots A/B;
después el terminal instala automáticamente la última release estable firmada.
USB permanece como recuperación. Consulta el procedimiento operativo,
el cableado Grove A y los gestos de recuperación en
[`firmware/terminal/README.md`](../firmware/terminal/README.md).
Si distribuyes `firmware.bin`, acompáñalo con
[`firmware/terminal/THIRD_PARTY_NOTICES`](../firmware/terminal/THIRD_PARTY_NOTICES)
y el directorio completo [`firmware/terminal/LICENSES/`](../firmware/terminal/LICENSES/).
Los avisos no sustituyen las obligaciones de código fuente u objetos
relocalizables que puedan exigir las licencias del build exacto.

### Operación USB y recuperación

La interfaz `OJUSB/1` permite a la CLI prevista `openjornada-terminal` ejecutar
`ports`, `status`, `doctor`, `logs --follow`, `provision`, `reboot`,
`factory-reset`, `firmware check`, `firmware update` y
`firmware install ARCHIVO.bin`. La detección automática debe fallar si encuentra
cero o más de un terminal. El OJP entra de forma interactiva sin eco o mediante
`--ojp-stdin`; no debe pasarse como argumento ni guardarse en logs.

El aprovisionamiento CLI funciona dentro del portal: su adaptador serie atiende
`hello`, `status`, `doctor` y `provision`, por lo que tanto la autodetección como
un puerto explícito validan primero protocolo, placa, firmware y
`mode: provisioning`. Las respuestas de estado y diagnóstico sólo exponen el
contexto público (configuración presente, conectividad, pendientes y
disponibilidad de almacenamiento/RFID); nunca credenciales, IP ni UID. Después
de aceptar el OJP, el terminal reutiliza exactamente la validación Wi-Fi,
`bootstrap`, eventos y persistencia del portal web.

Estado y diagnóstico son operaciones de lectura. Aprovisionar sólo se admite
en el portal abierto con A+B durante cinco segundos. Reset y firmware
personalizado requieren mantener sólo C cinco segundos y caducan tras 30
segundos; la confirmación física no identifica a la persona operadora. El
firmware oficial necesita manifiesto y firma Ed25519 válidos. El personalizado
debe ser un build compatible de OpenJornada con bloque `OJFW_META_V1`, placa
`m5stack-basic-core-v27`, protocolo 1 y SemVer. Cualquier instalación se rechaza
si `pendingCount` no es cero; la operación correcta es sincronizar o resolver la
cola, nunca borrarla para eludir el control.

Para una aceptación física rutinaria, usa sólo una placa y backend demo:

1. Registra puerto estable, SO, versión y `PASS`/`FAIL`, sin OJP, credenciales,
   UID, IP ni salida serie arbitraria.
2. Ejecuta `ports`, `status`, `doctor` y `logs --follow`; verifica los modos y
   que sólo aparecen eventos saneados.
3. Mantén A+B para abrir el portal y ejecuta `provision --ojp-stdin` con
   credenciales demo. Exige que el handshake muestre `mode: provisioning`, que
   se reciban `connecting`, `validating` y `saved`, y que el OJP no aparezca en
   salida. Tras el reinicio, ejecuta `status` y comprueba `mode: ready`.
4. Solicita `factory-reset` y cancela o deja vencer los 30 segundos sin mantener
   C; comprueba que configuración y pendientes no cambian.
5. Solicita instalar un build compatible y cancela antes de mantener C; no debe
   empezar la transferencia ni cambiar la versión.
6. Instala previamente una release oficial con `OJUSB/1` anterior a otra estable
   firmada más nueva. En la organización demo crea una persona, tag y credencial
   exclusivos sin registrar UID ni secretos; tras `bootstrap` y NTP, espera a
   que termine **Actualizando credenciales locales…** y vuelva la pantalla
   inactiva. Corta entonces la red del banco, presenta el tag, confirma la acción
   sintética en pantalla y comprueba `pendingCount: 1`. Ejecuta
   `firmware update` y exige `pending_actions` antes de transferir un byte;
   después restaura la red y sincroniza la acción demo. Si no hay una release
   oficial más nueva, marca el paso `NO EJECUTADO`: no simules la firma ni
   fuerces una OTA. La CI cubre la política oficial mediante
   `test_usb_firmware_install_policy_fails_closed` y el rechazo del servicio en
   `test_usb_firmware_begin_rejects_pending_busy_and_unproved_official`.
7. Ejecuta `reboot`, seguido de `status` y `doctor`, y comprueba que los datos se
   conservan.

No ejecutes en esta lista el reset confirmado, la escritura OTA, la interrupción
de transferencia ni el rollback. Esas pruebas necesitan autorización separada,
placa sacrificable y copia restaurable. El detalle reproducible y los códigos
esperados están en
[`firmware/terminal/README.md`](../firmware/terminal/README.md).

Si el terminal no arranca o no completa el handshake, la CLI no puede recuperar
bootloader ni particiones. Compila y carga el perfil completo con PlatformIO:

```bash
cd firmware/terminal
uv tool run --from platformio==6.1.19 platformio run -e m5stack_release
uv tool run --from platformio==6.1.19 platformio run -e m5stack_release \
  --target upload --upload-port /dev/serial/by-id/usb-dispositivo-de-laboratorio
```

Este flujo usa `esptool` y los offsets que valida el proyecto. Si falla el acceso
al cargador ROM, escala al procedimiento del fabricante; no inventes un
`write_flash` ni ejecutes `erase_flash`, porque un borrado completo elimina NVS,
LittleFS, credenciales y fichajes pendientes.

### Publicación del firmware

Configura `FIRMWARE_SIGNING_PRIVATE_KEY_B64` como secreto de Actions. Debe ser
el PEM PKCS#8 de la clave Ed25519 de producción codificado en Base64 y su pública
debe coincidir con `firmware/terminal/keys/production-ed25519-public.pem`.
No imprimas ni reutilices la privada.

Al publicar una release estable, `publish-firmware.yml` compila el perfil
`m5stack_release`, verifica el límite del 85 %, genera y firma el manifiesto y
adjunta binario, manifiesto, firma y paquete de licencias. El manifiesto se sube
en último lugar; las prereleases no se ofrecen por OTA. La firma se ejecuta en
un job aislado del build y todas las Actions usadas están fijadas por commit.

## Despliegue en proveedores gestionados

OpenJornada necesita una única instancia con almacenamiento persistente montado
en `/app/pb_data`. No actives escalado horizontal: PocketBase usa SQLite y el
volumen no debe compartirse entre varias réplicas escritoras.

Antes de desplegar prepara:

- una `PB_ENCRYPTION_KEY` aleatoria de exactamente 32 caracteres;
- las credenciales de la primera cuenta administradora;
- el nombre y el identificador fiscal de la organización;
- una URL HTTPS pública que se usará como `PB_PUBLIC_URL`;
- un destino externo para copias cifradas del volumen.

Mantén `PB_DEMO_ENABLED=false` y `PB_TERMINAL_DEV_INSECURE_HTTP=false`.
Configura SMTP después del primer acceso si no quieres introducir las
credenciales durante el alta. En todos los proveedores, comprueba al terminar:

```text
GET https://tu-dominio.example/api/health
```

### Coolify

El botón del README abre esta guía porque una instalación de Coolify puede usar
un dominio distinto y no existe una URL universal de importación.

1. Crea un recurso desde el repositorio público
   `https://github.com/GNURub/openjornada`.
2. Selecciona el build pack **Docker Compose** y el archivo
   `/deploy/docker-compose.cloud.yml`.
3. Asigna un dominio HTTPS al servicio `app` y al puerto `8090`.
4. Completa todas las variables marcadas como obligatorias. Usa la URL exacta
   del dominio como `PB_PUBLIC_URL`.
5. Confirma que el volumen `openjornada_data` está montado en
   `/app/pb_data` y que sólo existe una réplica.
6. Despliega y comprueba `/api/health`.

El Compose cloud no publica el puerto directamente en el host; Coolify lo
expone mediante su proxy. Consulta la documentación oficial de
[Docker Compose](https://coolify.io/docs/applications/build-packs/docker-compose),
[variables](https://coolify.io/docs/knowledge-base/environment-variables) y
[almacenamiento persistente](https://coolify.io/docs/knowledge-base/persistent-storage).

### Railway

Railway detecta el Dockerfile y aplica [`railway.json`](../railway.json) para el
health check y la política de reinicio.

1. Crea un proyecto desde el repositorio de GitHub y selecciona la rama `main`.
2. En el servicio, añade un volumen con punto de montaje `/app/pb_data`.
3. Genera un dominio público y mantén una sola réplica.
4. Añade las variables obligatorias. Puedes definir:

   ```dotenv
   PB_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
   PB_DEMO_ENABLED=false
   ```

5. Despliega y comprueba `/api/health`.

El botón seguirá siendo guiado hasta que se publique una plantilla de
OpenJornada en Railway; no se usa un identificador de plantilla ficticio.
Consulta la documentación oficial sobre
[Dockerfiles](https://docs.railway.com/builds/dockerfiles),
[volúmenes](https://docs.railway.com/reference/volumes) y
[variables](https://docs.railway.com/variables/reference).

### Render

El botón **Deploy to Render** usa [`render.yaml`](../render.yaml) y crea:

- un servicio Docker `starter` en Frankfurt;
- una sola instancia y un disco de 1 GB en `/app/pb_data`;
- el health check `/api/health`;
- `PB_PUBLIC_URL` enlazado automáticamente con `RENDER_EXTERNAL_URL`;
- despliegues automáticos desactivados para que cada instalación controle sus
  actualizaciones.

Durante el alta, Render solicita la clave de cifrado, los datos de la
organización y las credenciales administrativas. El disco persistente requiere
un plan de pago. No sustituyas la clave por un secreto generado por Render:
`PB_ENCRYPTION_KEY` debe tener exactamente 32 caracteres.

Después del primer despliegue configura SMTP, revisa la visibilidad del panel
`/_/` y programa una copia externa. Consulta la documentación oficial del
[botón](https://render.com/docs/deploy-to-render),
[Blueprint](https://render.com/docs/blueprint-spec) y
[disco persistente](https://render.com/docs/disks).

### Fly.io

[`fly.toml`](../fly.toml) configura una Machine en Madrid, HTTPS, puerto interno
`8090`, health check y el montaje `/app/pb_data`.

```bash
fly apps create <nombre-app>
fly volumes create openjornada_data \
  --app <nombre-app> \
  --region mad \
  --size 1

fly secrets set --app <nombre-app> \
  PB_PUBLIC_URL=https://<nombre-app>.fly.dev \
  PB_ENCRYPTION_KEY=<32-caracteres> \
  PB_ORGANIZATION_NAME=<empresa> \
  PB_ORGANIZATION_TAX_ID=<identificador> \
  PB_BOOTSTRAP_ADMIN_EMAIL=<correo> \
  PB_BOOTSTRAP_ADMIN_PASSWORD=<contraseña>

fly deploy --app <nombre-app>
fly status --app <nombre-app>
```

No aumentes el número de Machines. Configura los secretos SMTP con
`fly secrets set` cuando sean necesarios. Consulta la documentación oficial de
[`fly deploy`](https://fly.io/docs/launch/deploy/) y
[volúmenes](https://fly.io/docs/reference/configuration/#the-mounts-section).

### Zeabur

1. Crea un proyecto y añade un servicio desde el repositorio de GitHub.
2. Zeabur detectará el Dockerfile de la raíz; publica el puerto HTTP `8090`.
3. Monta un volumen en `/app/pb_data` antes de introducir datos.
4. Genera o enlaza el dominio, configura `PB_PUBLIC_URL` con su URL HTTPS y
   añade el resto de variables obligatorias.
5. Mantén una sola instancia, despliega y comprueba `/api/health`.

El botón apunta a esta guía hasta que una plantilla de OpenJornada sea publicada
por el propietario en Zeabur. Consulta la documentación oficial sobre
[Dockerfile](https://zeabur.com/docs/en-US/deploy/methods/dockerfile),
[volúmenes](https://zeabur.com/docs/en-US/data-management/volumes) y
[botones de plantilla](https://zeabur.com/docs/en-US/deploy/methods/deploy-button).

### Northflank

1. Crea un **combined service** desde el repositorio y selecciona el Dockerfile
   de la raíz.
2. Publica el puerto HTTP `8090` y configura `/api/health` como health check.
3. Añade un volumen **Single Read/Write** montado en `/app/pb_data`.
4. Limita el servicio a una instancia y añade las variables obligatorias.
5. Usa el dominio público HTTPS como `PB_PUBLIC_URL`, despliega y verifica la
   API.

No se enlaza una plantilla pública hasta que el propietario la publique en
Northflank. Consulta la documentación oficial para
[crear el servicio](https://northflank.com/docs/v1/application/getting-started/build-and-deploy-your-code),
[añadir el volumen](https://northflank.com/docs/v1/application/databases-and-persistence/add-a-volume)
y [crear una plantilla](https://northflank.com/docs/v1/application/infrastructure-as-code/create-a-template).

### Por qué no se ofrece Vercel

Vercel admite `Dockerfile.vercel`, pero ejecuta las imágenes como funciones
autoscalables y sin estado. OpenJornada guarda SQLite y archivos en
`/app/pb_data`; esos datos no sobrevivirían al reemplazo o escalado de una
instancia. Docker Compose no añade un volumen durable en Vercel.

No despliegues datos reales allí mientras Vercel no proporcione almacenamiento
durable compatible con PocketBase. Consulta su
[comparativa oficial de contenedores](https://vercel.com/kb/guide/docker-on-vercel-vs-render).

## Primera instalación

```bash
git clone https://github.com/GNURub/openjornada.git
cd openjornada
cp .env.example .env
openssl rand -hex 16
```

Guarda la clave generada en un gestor de secretos y edita `.env`:

```dotenv
PB_APP_NAME=OpenJornada
PB_PUBLIC_URL=https://jornada.example.com
PB_ENCRYPTION_KEY=32-caracteres-generados
PB_MCP_ENABLED=true
PB_MCP_INTERNAL_URL=http://127.0.0.1:8090
PB_ORGANIZATION_NAME=Empresa de ejemplo
PB_ORGANIZATION_TAX_ID=B12345678
PB_TIMEZONE=Europe/Madrid
PB_BOOTSTRAP_ADMIN_EMAIL=admin@example.com
PB_BOOTSTRAP_ADMIN_PASSWORD=una-contrasena-larga-y-unica
PB_DEMO_ENABLED=false
PB_TERMINAL_DEV_INSECURE_HTTP=false

PB_MAIL_SENDER_NAME=OpenJornada
PB_MAIL_SENDER_ADDRESS=no-reply@example.com
PB_SMTP_HOST=smtp.example.com
PB_SMTP_PORT=587
PB_SMTP_USERNAME=usuario
PB_SMTP_PASSWORD=secreto
PB_SMTP_TLS=false
```

Arranca y comprueba:

```bash
docker compose -f docker-compose.production.yml config --quiet
docker compose -f docker-compose.production.yml up -d --build
docker compose -f docker-compose.production.yml ps
curl -fsS http://127.0.0.1:8090/api/health
```

Las migraciones se ejecutan antes de iniciar el servidor. Si una migración falla,
el contenedor no empieza a servir tráfico.

## Correo SMTP

OpenJornada configura el correo de PocketBase durante el arranque. SMTP es
opcional para servir la aplicación, pero hace falta para entregar invitaciones
de acceso, mensajes de recuperación de contraseña y los avisos programados de
ausencias, documentos y tareas asignadas, y comunicaciones. Los avisos de
documentos y tareas no incluyen su título, categoría, descripción, archivo ni
enlace de descarga: la persona debe autenticarse en OpenJornada para consultar
esos datos.

| Variable                 | Descripción                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `PB_MAIL_SENDER_NAME`    | Nombre mostrado como remitente. Si falta, se usa `PB_APP_NAME`.                                |
| `PB_MAIL_SENDER_ADDRESS` | Dirección remitente. Debe estar permitida o verificada por el proveedor.                       |
| `PB_SMTP_HOST`           | Nombre DNS o dirección del servidor SMTP. Un valor no vacío activa SMTP.                       |
| `PB_SMTP_PORT`           | Puerto del servidor. El valor predeterminado de OpenJornada es `587`.                          |
| `PB_SMTP_USERNAME`       | Usuario SMTP. Algunos proveedores esperan aquí una cuenta o un identificador.                  |
| `PB_SMTP_PASSWORD`       | Contraseña de aplicación, token o secreto SMTP entregado por el proveedor.                     |
| `PB_SMTP_TLS`            | `true` obliga una conexión TLS; `false` envía STARTTLS y deja al servidor decidir si la eleva. |

Ejemplo genérico; sustituye todos los valores por los indicados por el proveedor:

```dotenv
PB_MAIL_SENDER_NAME=OpenJornada
PB_MAIL_SENDER_ADDRESS=no-reply@jornada.example.com
PB_SMTP_HOST=smtp.proveedor.example
PB_SMTP_PORT=587
PB_SMTP_USERNAME=usuario-smtp
PB_SMTP_PASSWORD=contraseña-de-aplicacion-o-secreto-smtp
PB_SMTP_TLS=false
```

No deduzcas el valor de `PB_SMTP_TLS` únicamente por el número de puerto. Algunos
proveedores ofrecen STARTTLS y otros exigen TLS desde el inicio; sigue siempre
su documentación. Si el servicio usa autenticación multifactor, normalmente
necesitarás una contraseña de aplicación o credencial SMTP específica.

### Aplicar cambios

Las variables se leen desde `.env` al crear el contenedor y PocketBase las
guarda en sus ajustes durante el arranque. Valida la configuración de Compose
sin imprimir la configuración resuelta y recrea el servicio:

```bash
docker compose -f docker-compose.production.yml config --quiet
docker compose -f docker-compose.production.yml up -d --force-recreate app
docker compose -f docker-compose.production.yml logs --since=5m app
```

`docker compose restart` no vuelve a leer `.env`. Evita ejecutar
`docker compose config` sin `--quiet` en terminales compartidos o registros de
CI, porque la salida resuelta puede contener `PB_SMTP_PASSWORD`.

En una instalación nueva, dejar `PB_SMTP_HOST` vacío mantiene SMTP sin activar.
En una base existente, borrar esa variable no garantiza que se elimine una
configuración previamente guardada. Para revocarla, rota primero el secreto del
proveedor y comprueba el estado desde el panel restringido de PocketBase.

### Verificar la entrega

El endpoint `/api/health` no establece una conexión SMTP. Realiza una prueba
funcional:

1. Crea o usa una cuenta de prueba con un buzón controlado.
2. Envía una invitación desde **Tu equipo**.
3. Comprueba la recepción, el nombre y dirección del remitente y la carpeta de
   correo no deseado.
4. Confirma que el enlace apunta a la URL HTTPS definida en `PB_PUBLIC_URL`.
5. Verifica que permite crear una contraseña, inicia sesión automáticamente,
   cambia el estado a **Aceptada** y deja de funcionar al reutilizarlo.
6. Revisa en el proveedor el resultado de entrega sin copiar credenciales,
   enlaces de recuperación ni datos personales a los registros.

Repite la comprobación asignando un documento y una tarea de prueba a otra
persona. Los correos deben ser genéricos y las notificaciones internas
autenticadas deben mostrar los títulos y enlazar a `/documentos` y `/tareas`.

Antes de producción, configura SPF, DKIM y DMARC para el dominio remitente según
las instrucciones del proveedor. Usa credenciales dedicadas con el mínimo
alcance posible, guárdalas en un gestor de secretos y rótalas periódicamente.

## Proxy HTTPS

El compose de producción enlaza PocketBase únicamente a `127.0.0.1:8090`.
Ejemplo mínimo con Caddy:

```caddyfile
jornada.example.com {
    encode zstd gzip

    @pocketbaseAdmin path /_/*
    respond @pocketbaseAdmin 403

    reverse_proxy 127.0.0.1:8090
}
```

Si necesitas el panel de superusuario, publícalo sólo mediante VPN, túnel SSH o
una lista de IP autorizadas. No elimines el bloqueo global sin otro control.

La comprobación de conexión de los terminales obtiene la IP pública mediante
la configuración **Trusted proxy** de PocketBase. Si PocketBase sólo es
accesible a través de tu proxy, configura allí la cabecera que éste controla
por completo —por ejemplo, `X-Forwarded-For`— y selecciona `UseLeftmostIP`
según la topología real de proxies. Sin una cabecera confiable configurada se
muestra la IP del peer directo, normalmente la del proxy. No confíes en una
cabecera reenviada mientras PocketBase también sea accesible directamente ni
permitas que el cliente sustituya el valor escrito por el proxy.

Configura el proxy para aceptar el tamaño máximo de los documentos permitidos
por la aplicación y transmitir correctamente conexiones HTTP largas.
`/mcp` usa Streamable HTTP: conserva `Authorization`, `Origin`, `Accept` y
`Content-Type`, admite `POST`, y desactiva buffering y caché para esa ruta. No
registres la cabecera `Authorization`.

Las descargas MCP pasan por `/api/openjornada/mcp-files` con una firma efímera
en la query. Excluye esa ruta de logs de acceso o redacta por completo su query
string; nunca la envíes a analítica. Respeta su respuesta
`Cache-Control: private, no-store`.
No sobrescribas la cabecera `Cache-Control: no-store` de
`/api/openjornada/branding/*/manifest.json`: el manifiesto y los recursos de
marca pueden cambiar desde la configuración de cada empresa.

## Operación

```bash
docker compose -f docker-compose.production.yml logs -f app
docker compose -f docker-compose.production.yml restart app
docker compose -f docker-compose.production.yml ps
```

El endpoint de monitorización es:

```text
GET /api/health
```

Monitoriza además espacio en disco, estado del volumen, caducidad TLS, entrega
SMTP, errores del contenedor y tasas anómalas de `401`/`429` en `/mcp` sin
registrar tokens ni parámetros firmados.

## Copia de seguridad

Los logotipos y sus iconos PWA derivados se almacenan junto a los demás archivos
de PocketBase en `/app/pb_data`; quedan incluidos al copiar el volumen. Las
variantes de 16, 32, 180 y 192 px se generan como miniaturas de PocketBase.

Obtén el nombre real del volumen para no depender del nombre del directorio:

```bash
openjornada_volume=$(docker inspect \
  "$(docker compose -f docker-compose.production.yml ps -q app)" \
  --format '{{range .Mounts}}{{if eq .Destination "/app/pb_data"}}{{.Name}}{{end}}{{end}}')
mkdir -p backups
docker compose -f docker-compose.production.yml stop app
docker run --rm \
  -v "$openjornada_volume:/source:ro" \
  -v "$PWD/backups:/backup" \
  alpine:3.23 \
  tar -czf "/backup/openjornada-$(date +%F-%H%M%S).tar.gz" -C /source .
docker compose -f docker-compose.production.yml start app
```

Cifra y copia el archivo fuera del servidor. Conserva varias generaciones.

La retención de fichajes se configura con un mínimo de cuatro años. Antes de
cualquier depuración futura:

1. registra en **Ajustes → Preservaciones legales** todas las inspecciones,
   reclamaciones, litigios y obligaciones de bloqueo;
2. revisa la vista previa de registros antiguos y protegidos;
3. toma y verifica una copia cifrada;
4. documenta la autorización y prueba el procedimiento fuera de producción.

La versión actual no ejecuta purgas automáticas: la vista previa devuelve
`destructiveActionExecuted: false`. No borres filas directamente de SQLite,
porque romperías referencias, resúmenes y cadenas de integridad.

## Restauración

Prueba primero en otro servidor. La restauración reemplaza todos los datos del
volumen seleccionado:

1. Detén la aplicación.
2. Confirma el nombre exacto del volumen.
3. Conserva una copia adicional del estado actual.
4. Vacía únicamente ese volumen y extrae el backup dentro.
5. Arranca y verifica `/api/health`, acceso, documentos y fichajes.

No reutilices una `PB_ENCRYPTION_KEY` distinta al restaurar una base que contenga
secretos cifrados.

## Actualización

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
docker compose -f docker-compose.production.yml build --pull
docker compose -f docker-compose.production.yml up -d
curl -fsS http://127.0.0.1:8090/api/health
```

Haz un backup antes de actualizar. PocketBase sigue antes de la versión 1.0:
revisa siempre su changelog y prueba migraciones y restauración fuera de
producción.

## Calendario laboral de España

La importación guiada necesita salida HTTPS desde el contenedor hacia
`calendariosnacionales.com`. La consulta se realiza sólo desde el servidor, con
timeout, límite de respuesta, validación de rutas y caché en memoria de seis
horas. No abras ninguna ruta entrante adicional ni expongas el proveedor desde
el navegador. Si el servicio no está disponible, la creación y edición manual
de festivos sigue funcionando.

La atribución visible al proveedor y el aviso de contraste con fuentes oficiales
forman parte de la pantalla de previsualización; no deben eliminarse al adaptar
la interfaz.

## Lista de comprobación

- `PB_DEMO_ENABLED=false`.
- `PB_TERMINAL_DEV_INSECURE_HTTP=false`.
- URL pública HTTPS correcta.
- Clave de cifrado respaldada y no incluida en Git.
- Contraseñas únicas y SMTP funcional.
- Puerto 8090 no expuesto a Internet.
- Panel `/_/` restringido.
- `PB_MCP_ENABLED` revisado; usa `false` como corte de emergencia si se
  compromete un cliente.
- Tokens MCP inventariados, con caducidad mínima y revocación probada.
- Proxy sin logs de credenciales o queries firmadas y sin caché en `/mcp` y
  `/api/openjornada/mcp-files`.
- Backups externos cifrados y restauración probada.
- Retención mínima de cuatro años revisada y preservaciones legales activas
  antes de cualquier tratamiento de datos antiguos.
- Monitorización y alertas activas.
- Salida HTTPS al proveedor de calendario verificada o procedimiento manual documentado.
- Revisión de [COMPLIANCE_ES.md](COMPLIANCE_ES.md) completada.
