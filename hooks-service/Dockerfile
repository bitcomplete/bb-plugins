# syntax=docker/dockerfile:1

# The hooks service is a single static Go binary. Build it with the pinned
# toolchain, then ship only the binary on a distroless base: no shell, no
# package manager, nothing to write to disk.
FROM golang:1.25.1-bookworm AS build

WORKDIR /src

# Dependencies first, so a source-only change reuses the module cache layer.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# VERSION is the image tag (or the git ref for a binary build). It lands in
# the Sentry release tag via sentryx.release; "dev" outside a built image.
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X hooks-service/sentryx.release=${VERSION}" \
      -o /out/hooks-service ./cmd/hooks-service

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/hooks-service /usr/local/bin/hooks-service

# 8080 public (one path per source), 8081 subscriber API (keep private),
# 9090 health.
EXPOSE 8080 8081 9090

USER nonroot:nonroot

ENTRYPOINT ["/usr/local/bin/hooks-service"]
