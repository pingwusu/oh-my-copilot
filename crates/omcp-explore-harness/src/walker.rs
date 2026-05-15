// Shared filesystem walker used by `find` and `grep`.
//
// Skips noisy directories so the harness stays fast on real repos.

use walkdir::{DirEntry, WalkDir};

const SKIP_DIRS: &[&str] = &["node_modules", "target", ".git", "dist", ".omc", ".omcp"];
pub const MAX_DEPTH: usize = 12;

/// Returns true if a directory entry is one we should descend into / yield.
/// The caller still has to decide if files vs dirs are interesting.
fn is_skipped_dir(entry: &DirEntry) -> bool {
    if !entry.file_type().is_dir() {
        return false;
    }
    match entry.file_name().to_str() {
        Some(name) => SKIP_DIRS.contains(&name),
        None => false,
    }
}

/// Build a WalkDir iterator with the project-wide skip rules applied.
/// Hidden dot-dirs other than the explicit skip list are still descended,
/// matching omx-explore-harness behaviour.
pub fn iter_files(
    root: &std::path::Path,
) -> impl Iterator<Item = Result<DirEntry, walkdir::Error>> {
    WalkDir::new(root)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_skipped_dir(e))
}
