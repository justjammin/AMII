FROM rust:1-slim AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM gcr.io/distroless/cc-debian12
COPY --from=build /src/target/release/amii-api /usr/local/bin/amii-api
ENV PORT=8080
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/usr/local/bin/amii-api"]
