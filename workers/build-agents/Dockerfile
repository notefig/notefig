# The container an agent works in: what Notefig's tests and git hooks need, and nothing that grants access.
# The repository is cloned at start, and dependencies installed then, through the hosts the Durable Object intercepts.
# Built and pushed by `wrangler deploy`. Containers run linux/amd64.
FROM --platform=linux/amd64 node:22-bookworm

# Tauri's Linux libraries (`cargo test` for src-tauri), git, and build tools.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		git ca-certificates curl build-essential file pkg-config \
		libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
	&& rm -rf /var/lib/apt/lists/*

# Rust, for the desktop app's Tauri side.
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
	&& chmod -R a+w "$RUSTUP_HOME" "$CARGO_HOME"

# Playwright's Chromium for the e2e suite the pre-push hook runs. Keep the version equal to package-lock.json's.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx -y playwright@1.59.0 install --with-deps chromium

# The Sandbox SDK's helper, which `Files` runs. Its tag matches the installed @cloudflare/sandbox.
COPY --from=docker.io/cloudflare/sandbox:1.0.1 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

RUN mkdir -p /workspace
WORKDIR /workspace
CMD ["sleep", "infinity"]
