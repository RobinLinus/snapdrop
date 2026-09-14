FROM rust:1.98-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
COPY --from=build /app/target/release/snapdrop-server /usr/local/bin/snapdrop-server
USER 65532:65532
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/snapdrop-server"]
