//! `notefig-mcp-relay <port>` (or `--mcp-stdio-relay <port>`): the stdio
//! relay a harness spawns as Notefig's MCP server. The app binary will do
//! the same via `notefig_agent::mcp::relay_main` when invoked with
//! `--mcp-stdio-relay <port>`; this bin exists until it does.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(port) = notefig_agent::mcp::relay::relay_port_from_args(&args) else {
        eprintln!("usage: notefig-mcp-relay [--mcp-stdio-relay] <port>   (env NOTEFIG_MCP_TOKEN)");
        std::process::exit(2);
    };
    std::process::exit(notefig_agent::mcp::relay_main(port));
}
