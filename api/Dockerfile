# Builder and runtime must share a Debian release (glibc): bookworm <-> distroless debian12.
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY giphy ./giphy
COPY src ./src
RUN cargo build --release --locked --bin amii-api

FROM gcr.io/distroless/cc-debian12
COPY --from=build /src/target/release/amii-api /usr/local/bin/amii-api
# Curated GIPHY-per-character manifest (written by agent/, reviewed in PRs).
COPY manifests /manifests
ENV GIPHY_MANIFEST=/manifests/giphy-characters.json
ENV PORT=8080
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/usr/local/bin/amii-api"]
