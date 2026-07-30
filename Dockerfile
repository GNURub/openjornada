FROM ghcr.io/pnpm/pnpm:11.17.0@sha256:e26f380828856f205feaaf42abd157df9ce41bc8e17b662eeaa3379a9638dee0 AS pnpm

FROM node:26-slim AS web-builder
COPY --from=pnpm /opt/pnpm /opt/pnpm
ENV PATH="/opt/pnpm:${PATH}"
WORKDIR /app/web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm run build

FROM alpine:3.23
ARG PB_VERSION=0.39.9
ARG TARGETARCH
RUN apk add --no-cache ca-certificates curl tzdata unzip \
    && case "${TARGETARCH}" in \
      amd64) PB_ARCH=amd64 ;; \
      arm64) PB_ARCH=arm64 ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" && exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/pocketbase.zip \
      "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${PB_ARCH}.zip" \
    && unzip /tmp/pocketbase.zip -d /app \
    && rm /tmp/pocketbase.zip
WORKDIR /app
COPY backend/pb_migrations ./pb_migrations
COPY backend/pb_hooks ./pb_hooks
COPY --from=web-builder /app/web/dist/web/browser ./pb_public
EXPOSE 8090
VOLUME ["/app/pb_data"]
CMD ["sh", "-c", "/app/pocketbase migrate up --dir=/app/pb_data --migrationsDir=/app/pb_migrations --hooksDir=/app/pb_hooks --encryptionEnv=PB_ENCRYPTION_KEY && exec /app/pocketbase serve --http=0.0.0.0:8090 --dir=/app/pb_data --migrationsDir=/app/pb_migrations --hooksDir=/app/pb_hooks --encryptionEnv=PB_ENCRYPTION_KEY"]
