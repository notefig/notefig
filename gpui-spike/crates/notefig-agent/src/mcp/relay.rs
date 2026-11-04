//! The stdio ⇄ TCP relay a harness spawns as its MCP server (port of
//! `mcp_bridge.rs::run_mcp_stdio_relay`). Plain std threads: it runs in its
//! own short-lived process.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

pub const MCP_TOKEN_ENV: &str = "NOTEFIG_MCP_TOKEN";
/// The flag the app binary answers to (`notefig --mcp-stdio-relay <port>`).
pub const RELAY_FLAG: &str = "--mcp-stdio-relay";
pub const RELAY_BIN_NAME: &str = "notefig-mcp-relay";

/// What the harness runs for the app's MCP server: `program [args…] <port>`.
#[derive(Debug, Clone, PartialEq)]
pub struct RelayCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
}

impl RelayCommand {
    /// The app's own binary: `<exe> --mcp-stdio-relay <port>`.
    pub fn app_exe(exe: PathBuf) -> RelayCommand {
        RelayCommand {
            program: exe,
            args: vec![RELAY_FLAG.into()],
        }
    }

    /// Default: the `notefig-mcp-relay` bin beside the current exe (or one
    /// directory up — cargo puts examples in `target/<profile>/examples`),
    /// else the current exe with `--mcp-stdio-relay`.
    pub fn discover() -> RelayCommand {
        let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("notefig"));
        let name = if cfg!(windows) {
            format!("{RELAY_BIN_NAME}.exe")
        } else {
            RELAY_BIN_NAME.to_string()
        };
        let mut dir = exe.parent().map(PathBuf::from);
        for _ in 0..2 {
            let Some(d) = dir else { break };
            let candidate = d.join(&name);
            if candidate.is_file() {
                return RelayCommand {
                    program: candidate,
                    args: vec![],
                };
            }
            dir = d.parent().map(PathBuf::from);
        }
        RelayCommand::app_exe(exe)
    }
}

/// Parse `<port>` or `--mcp-stdio-relay <port>` from argv (after argv[0]).
pub fn relay_port_from_args(args: &[String]) -> Option<u16> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == RELAY_FLAG {
            return iter.next()?.parse().ok();
        }
        if let Ok(port) = arg.parse() {
            return Some(port);
        }
    }
    None
}

/// Connect to the app's loopback listener, present `$NOTEFIG_MCP_TOKEN`,
/// then pump stdin → socket and socket → stdout line by line until either
/// side closes. Returns the process exit code.
pub fn relay_main(port: u16) -> i32 {
    let Ok(stream) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
        return 1;
    };
    let Ok(mut write_stream) = stream.try_clone() else {
        return 1;
    };
    if let Ok(token) = std::env::var(MCP_TOKEN_ENV)
        && writeln!(write_stream, "{token}").is_err()
    {
        return 1;
    }
    let up = std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            if writeln!(write_stream, "{line}").is_err() {
                break;
            }
        }
        let _ = write_stream.shutdown(std::net::Shutdown::Write);
    });
    let down = std::thread::spawn(move || {
        let reader = BufReader::new(stream);
        let mut stdout = std::io::stdout();
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if writeln!(stdout, "{line}").is_err() || stdout.flush().is_err() {
                break;
            }
        }
    });
    let _ = down.join();
    // The socket closed (app gone): don't wait on a blocked stdin read.
    if !up.is_finished() {
        return 0;
    }
    let _ = up.join();
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_port_args() {
        assert_eq!(
            relay_port_from_args(&["--mcp-stdio-relay".into(), "123".into()]),
            Some(123)
        );
        assert_eq!(relay_port_from_args(&["456".into()]), Some(456));
        assert_eq!(relay_port_from_args(&[]), None);
    }
}
