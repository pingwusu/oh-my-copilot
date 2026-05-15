// omcp-explore: Rust hot-path harness for fast codebase exploration.
// Mirrors omx-explore-harness in role; invoked by the omcp CLI when present,
// with a TypeScript fallback path so the project remains usable without a
// Rust toolchain.
//
// Subcommands:
//   omcp-explore --version
//   omcp-explore find <glob>
//   omcp-explore grep <pattern> [--glob <g>]
//   omcp-explore symbols <file>
//   omcp-explore stat <file>
//
// Exit codes:
//   0 = success
//   1 = bad args / unrecognized subcommand
//   2 = io error

mod find;
mod grep;
mod stat;
mod symbols;
mod walker;

use std::env;
use std::process::ExitCode;

const USAGE: &str = "\
omcp-explore — fast codebase exploration harness

USAGE:
    omcp-explore --version
    omcp-explore find <glob>
    omcp-explore grep <pattern> [--glob <g>]
    omcp-explore symbols <file>
    omcp-explore stat <file>
";

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        eprintln!("{}", USAGE);
        return ExitCode::from(1);
    }

    // --version / -V short-circuit before subcommand dispatch.
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("omcp-explore {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }

    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{}", USAGE);
        return ExitCode::SUCCESS;
    }

    let sub = args[1].as_str();
    let rest = &args[2..];

    let result: Result<(), HarnessError> = match sub {
        "find" => dispatch_find(rest),
        "grep" => dispatch_grep(rest),
        "symbols" => dispatch_symbols(rest),
        "stat" => dispatch_stat(rest),
        other => {
            eprintln!("omcp-explore: unknown subcommand '{}'", other);
            eprintln!("{}", USAGE);
            return ExitCode::from(1);
        }
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(HarnessError::BadArgs(msg)) => {
            eprintln!("omcp-explore: {}", msg);
            ExitCode::from(1)
        }
        Err(HarnessError::Io(msg)) => {
            eprintln!("omcp-explore: io error: {}", msg);
            ExitCode::from(2)
        }
    }
}

#[derive(Debug)]
pub enum HarnessError {
    BadArgs(String),
    Io(String),
}

impl From<std::io::Error> for HarnessError {
    fn from(e: std::io::Error) -> Self {
        HarnessError::Io(e.to_string())
    }
}

impl From<regex::Error> for HarnessError {
    fn from(e: regex::Error) -> Self {
        HarnessError::BadArgs(format!("invalid regex: {}", e))
    }
}

fn dispatch_find(rest: &[String]) -> Result<(), HarnessError> {
    if rest.len() != 1 {
        return Err(HarnessError::BadArgs(
            "find requires exactly one <glob> argument".into(),
        ));
    }
    find::run(&rest[0])
}

fn dispatch_grep(rest: &[String]) -> Result<(), HarnessError> {
    if rest.is_empty() {
        return Err(HarnessError::BadArgs(
            "grep requires a <pattern> argument".into(),
        ));
    }
    let pattern = &rest[0];
    let mut glob: Option<&str> = None;
    let mut i = 1;
    while i < rest.len() {
        match rest[i].as_str() {
            "--glob" => {
                if i + 1 >= rest.len() {
                    return Err(HarnessError::BadArgs(
                        "--glob requires an argument".into(),
                    ));
                }
                glob = Some(rest[i + 1].as_str());
                i += 2;
            }
            other => {
                return Err(HarnessError::BadArgs(format!(
                    "unexpected grep arg '{}'",
                    other
                )));
            }
        }
    }
    grep::run(pattern, glob)
}

fn dispatch_symbols(rest: &[String]) -> Result<(), HarnessError> {
    if rest.len() != 1 {
        return Err(HarnessError::BadArgs(
            "symbols requires exactly one <file> argument".into(),
        ));
    }
    symbols::run(&rest[0])
}

fn dispatch_stat(rest: &[String]) -> Result<(), HarnessError> {
    if rest.len() != 1 {
        return Err(HarnessError::BadArgs(
            "stat requires exactly one <file> argument".into(),
        ));
    }
    stat::run(&rest[0])
}
