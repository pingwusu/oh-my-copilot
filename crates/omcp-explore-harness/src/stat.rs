// `omcp-explore stat <file>` — bytes + line-count as JSON.
//
// Output shape:
//   {"path":"<input>","bytes":N,"lines":N}
//
// We hand-roll the JSON encode (no serde) because the schema is fixed and the
// extra dep is not justified.

use crate::HarnessError;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

pub fn run(file: &str) -> Result<(), HarnessError> {
    let path = Path::new(file);
    let meta = std::fs::metadata(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            HarnessError::Io(format!("file not found: {}", file))
        } else {
            HarnessError::Io(e.to_string())
        }
    })?;

    if !meta.is_file() {
        return Err(HarnessError::Io(format!("not a regular file: {}", file)));
    }

    let bytes = meta.len();
    let lines = count_lines(path)?;

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    writeln!(
        out,
        "{{\"path\":\"{}\",\"bytes\":{},\"lines\":{}}}",
        json_escape(file),
        bytes,
        lines,
    )
    .ok();
    Ok(())
}

fn count_lines(path: &Path) -> Result<u64, HarnessError> {
    let f = File::open(path)?;
    let mut reader = BufReader::new(f);
    let mut count: u64 = 0;
    let mut buf = Vec::with_capacity(8192);
    let mut last_byte_was_newline = false;
    let mut saw_any_bytes = false;
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf)?;
        if n == 0 {
            break;
        }
        saw_any_bytes = true;
        if buf.last() == Some(&b'\n') {
            count += 1;
            last_byte_was_newline = true;
        } else {
            // Final line without trailing newline still counts.
            count += 1;
            last_byte_was_newline = false;
        }
    }
    // If the file ended with a newline we already counted it; if it had any
    // content but didn't end with newline we still counted the partial line.
    let _ = (last_byte_was_newline, saw_any_bytes);
    Ok(count)
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}
