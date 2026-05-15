// `omcp-explore grep <pattern> [--glob <g>]` — recursive content search.
//
// Output format mirrors `rg --no-heading -n`:
//   path:line:matched-line
//
// Binary detection is heuristic: we read up to 8KB and skip files that contain
// NUL bytes in that window. Lines longer than 4KB are truncated.

use crate::find::compile_glob;
use crate::walker;
use crate::HarnessError;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};

const MAX_LINE_BYTES: usize = 4096;
const BINARY_PROBE_BYTES: usize = 8192;

pub fn run(pattern: &str, glob: Option<&str>) -> Result<(), HarnessError> {
    let regex = regex::Regex::new(pattern)?;
    let glob_re = match glob {
        Some(g) => Some(compile_glob(g)?),
        None => None,
    };
    let cwd = std::env::current_dir()?;
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    for entry in walker::iter_files(&cwd) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let rel = path.strip_prefix(&cwd).unwrap_or(path);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if let Some(g) = &glob_re {
            if !g.is_match(&rel_str) {
                continue;
            }
        }

        if let Err(_e) = scan_file(path, &rel_str, &regex, &mut out) {
            // io errors on a single file should not abort the whole walk
            continue;
        }
    }
    Ok(())
}

fn scan_file<W: Write>(
    path: &std::path::Path,
    rel: &str,
    regex: &regex::Regex,
    out: &mut W,
) -> std::io::Result<()> {
    let f = File::open(path)?;
    let mut reader = BufReader::new(f);

    // Binary probe — peek without consuming.
    let probe = reader.fill_buf()?;
    let probe_len = probe.len().min(BINARY_PROBE_BYTES);
    if probe[..probe_len].contains(&0u8) {
        return Ok(());
    }

    let mut line_no: usize = 0;
    let mut buf = String::new();
    loop {
        buf.clear();
        let n = match reader.read_line(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break, // invalid utf-8 etc — stop on this file
        };
        line_no += 1;
        let trimmed = buf.trim_end_matches('\n').trim_end_matches('\r');
        if trimmed.len() > MAX_LINE_BYTES {
            continue;
        }
        if regex.is_match(trimmed) {
            writeln!(out, "{}:{}:{}", rel, line_no, trimmed).ok();
        }
        if n == 0 {
            break;
        }
    }
    Ok(())
}
