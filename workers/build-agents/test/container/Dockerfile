# What Pi's environment conformance suite needs: a POSIX shell, coreutils, and the Sandbox SDK's helper.
FROM --platform=linux/amd64 debian:bookworm-slim
COPY --from=docker.io/cloudflare/sandbox:1.0.1 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
CMD ["sleep", "infinity"]
