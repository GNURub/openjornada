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

Mantén `PB_DEMO_ENABLED=false`. Configura SMTP después del primer acceso si no
quieres introducir las credenciales durante el alta. En todos los proveedores,
comprueba al terminar:

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
