FROM ghcr.io/pnpm/pnpm:11.17.0@sha256:e26f380828856f205feaaf42abd157df9ce41bc8e17b662eeaa3379a9638dee0 AS pnpm

FROM node:26-slim AS web-builder
COPY --from=pnpm /opt/pnpm /opt/pnpm
ENV PATH="/opt/pnpm:${PATH}"
WORKDIR /app/web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm run build

FROM golang:1.25-alpine AS backend-builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/pocketbase ./cmd/openjornada

FROM alpine:3.23
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=backend-builder /out/pocketbase ./pocketbase
COPY backend/pb_migrations ./pb_migrations
COPY backend/pb_hooks ./pb_hooks
COPY --from=web-builder /app/web/dist/web/browser ./pb_public
EXPOSE 8090
VOLUME ["/app/pb_data"]
CMD ["sh", "-c", "/app/pocketbase migrate up --dir=/app/pb_data --migrationsDir=/app/pb_migrations --hooksDir=/app/pb_hooks --encryptionEnv=PB_ENCRYPTION_KEY && exec /app/pocketbase serve --http=0.0.0.0:8090 --dir=/app/pb_data --migrationsDir=/app/pb_migrations --hooksDir=/app/pb_hooks --encryptionEnv=PB_ENCRYPTION_KEY"]
