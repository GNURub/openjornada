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
PB_SMTP_TLS=true
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
SMTP y errores del contenedor.

## Copia de seguridad

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

## Lista de comprobación

- `PB_DEMO_ENABLED=false`.
- URL pública HTTPS correcta.
- Clave de cifrado respaldada y no incluida en Git.
- Contraseñas únicas y SMTP funcional.
- Puerto 8090 no expuesto a Internet.
- Panel `/_/` restringido.
- Backups externos cifrados y restauración probada.
- Monitorización y alertas activas.
- Revisión de [COMPLIANCE_ES.md](COMPLIANCE_ES.md) completada.
