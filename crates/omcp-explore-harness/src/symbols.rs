// `omcp-explore symbols <file>` — heuristic top-level outline.
//
// We pick a regex per file extension (.ts/.js/.tsx/.jsx/.rs/.py/.go) that
// captures common declaration prefixes (`fn`, `function`, `class`, `struct`,
// `enum`, `trait`, `impl`, `def`, `func`, `interface`, `type`). The output is
// one line per symbol:
//
//   kind:name:line
//
// This is intentionally simple — we do not parse. The omcp explore agent uses
// it as a "give me a quick skim" tool, not for refactors.

use crate::HarnessError;
use regex::Regex;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

struct Lang {
    patterns: Vec<(&'static str, Regex)>,
}

impl Lang {
    fn for_path(path: &Path) -> Option<Self> {
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        let raw: &[(&str, &str)] = match ext {
            "rs" => &[
                ("fn", r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)"),
                ("struct", r"^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)"),
                ("enum", r"^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)"),
                ("trait", r"^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)"),
                ("impl", r"^\s*impl(?:\s*<[^>]*>)?\s+([A-Za-z_][A-Za-z0-9_:<>, ]*?)\s*(?:\{|where|for)"),
                ("mod", r"^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)"),
            ],
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => &[
                ("function", r"^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)"),
                ("class", r"^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)"),
                ("interface", r"^\s*(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)"),
                ("type", r"^\s*(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*="),
                ("const", r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*="),
            ],
            "py" => &[
                ("def", r"^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)"),
                ("class", r"^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)"),
            ],
            "go" => &[
                ("func", r"^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)"),
                ("type", r"^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)"),
            ],
            _ => return None,
        };

        let mut patterns = Vec::with_capacity(raw.len());
        for (kind, src) in raw {
            // These are statically authored regexes; compile failure here is a
            // bug in this crate, not a user-input problem. Surface it as a
            // BadArgs-style message via HarnessError at runtime instead of
            // panicking — but we accept that unwrap is safe here since the
            // patterns are constants. To stay panic-free we filter_map.
            if let Ok(r) = Regex::new(src) {
                patterns.push((*kind, r));
            }
        }
        Some(Lang { patterns })
    }
}

pub fn run(file: &str) -> Result<(), HarnessError> {
    let path = Path::new(file);
    let lang = match Lang::for_path(path) {
        Some(l) => l,
        None => {
            // Unknown extension — emit nothing, exit success. This keeps the
            // tool composable in pipelines.
            return Ok(());
        }
    };

    let f = File::open(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            HarnessError::Io(format!("file not found: {}", file))
        } else {
            HarnessError::Io(e.to_string())
        }
    })?;
    let reader = BufReader::new(f);
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    for (idx, line_result) in reader.lines().enumerate() {
        let line_no = idx + 1;
        let line = match line_result {
            Ok(l) => l,
            Err(_) => continue,
        };
        for (kind, re) in &lang.patterns {
            if let Some(caps) = re.captures(&line) {
                if let Some(name) = caps.get(1) {
                    writeln!(out, "{}:{}:{}", kind, name.as_str().trim(), line_no).ok();
                    break; // one symbol per line
                }
            }
        }
    }
    Ok(())
}
