// `omcp-explore find <glob>` — walk cwd and print files matching the glob.
//
// Glob support is intentionally minimal: we translate the input into a regex
// that matches against the full forward-slash-normalised path. Supported
// wildcards:
//   *   — any run of non-separator characters
//   **  — any run of characters including path separators
//   ?   — single non-separator character
//   [..] — character class (passed straight to regex)
// Anything else is treated as a literal. This avoids pulling in a full glob
// crate while still being good enough for the common cases the explore agent
// asks for (e.g. `**/*.rs`, `src/**/main.*`).

use crate::walker;
use crate::HarnessError;
use std::io::Write;

pub fn run(pattern: &str) -> Result<(), HarnessError> {
    let regex = compile_glob(pattern)?;
    let cwd = std::env::current_dir()?;
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    for entry in walker::iter_files(&cwd) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // permission etc — skip silently, mirror ripgrep
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let rel = path.strip_prefix(&cwd).unwrap_or(path);
        let normalised = normalise(rel);
        if regex.is_match(&normalised) {
            writeln!(out, "{}", normalised).ok();
        }
    }
    Ok(())
}

fn normalise(p: &std::path::Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// Translate a minimal glob into an anchored regex.
pub fn compile_glob(glob: &str) -> Result<regex::Regex, HarnessError> {
    let mut re = String::with_capacity(glob.len() * 2 + 4);
    re.push('^');
    let bytes = glob.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        match c {
            '*' => {
                let is_double = i + 1 < bytes.len() && bytes[i + 1] == b'*';
                if is_double {
                    re.push_str(".*");
                    i += 2;
                    // Eat the trailing "/" of "**/" so it matches zero dirs too.
                    if i < bytes.len() && bytes[i] == b'/' {
                        i += 1;
                    }
                } else {
                    re.push_str("[^/]*");
                    i += 1;
                }
            }
            '?' => {
                re.push_str("[^/]");
                i += 1;
            }
            '.' | '+' | '(' | ')' | '|' | '^' | '$' | '{' | '}' | '\\' => {
                re.push('\\');
                re.push(c);
                i += 1;
            }
            '[' => {
                // Pass character class through verbatim until matching ']'.
                re.push('[');
                i += 1;
                while i < bytes.len() && bytes[i] != b']' {
                    re.push(bytes[i] as char);
                    i += 1;
                }
                if i < bytes.len() {
                    re.push(']');
                    i += 1;
                }
            }
            other => {
                re.push(other);
                i += 1;
            }
        }
    }
    re.push('$');
    Ok(regex::Regex::new(&re)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiles_star_glob() {
        let r = compile_glob("*.rs").unwrap();
        assert!(r.is_match("main.rs"));
        assert!(!r.is_match("src/main.rs"));
    }

    #[test]
    fn compiles_double_star() {
        let r = compile_glob("**/*.rs").unwrap();
        assert!(r.is_match("main.rs"));
        assert!(r.is_match("src/main.rs"));
        assert!(r.is_match("a/b/c/main.rs"));
        assert!(!r.is_match("main.txt"));
    }
}
