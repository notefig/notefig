// `ctx.exports`: loopback bindings for this Worker's own entrypoints, used to intercept the container's requests.
declare namespace Cloudflare {
	interface Exports {
		default: Fetcher;
		GitGateway(options: { props: import("./gateways.ts").GitGatewayProps }): Fetcher;
		RegistryGateway(options: { props?: object }): Fetcher;
	}
}
