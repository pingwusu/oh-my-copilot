// omcp-explore: Rust hot-path harness for fast codebase exploration.
// Mirrors omx-explore-harness in role; invoked by the omcp CLI when present,
// with a TypeScript fallback path so the project remains usable without a
// Rust toolchain.

use std::env;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("omcp-explore {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    eprintln!("omcp-explore: harness stub — implement search/glob/grep dispatchers in M3");
    ExitCode::SUCCESS
}
