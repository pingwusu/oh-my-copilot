// Integration tests for the `omcp-explore` binary.
//
// Each test invokes the compiled binary (via assert_cmd) with the fixtures
// directory as the working directory, and asserts on stdout / exit status.
//
// We can't run cargo on the dev host where this code is authored — these
// tests only run in CI.

use assert_cmd::Command;
use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures")
}

fn bin() -> Command {
    Command::cargo_bin("omcp-explore").expect("binary built")
}

#[test]
fn version_prints_and_exits_zero() {
    let assert = bin().arg("--version").assert().success();
    let out = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    assert!(out.contains("omcp-explore"), "stdout was: {}", out);
}

#[test]
fn find_matches_rs_files() {
    let dir = fixtures_dir();
    let assert = bin()
        .current_dir(&dir)
        .args(["find", "**/*.rs"])
        .assert()
        .success();
    let out = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    assert!(
        out.lines().any(|l| l.ends_with("sample.rs")),
        "expected sample.rs in find output, got: {}",
        out
    );
}

#[test]
fn find_returns_zero_with_no_matches() {
    let dir = fixtures_dir();
    bin()
        .current_dir(&dir)
        .args(["find", "**/*.nonexistent-ext"])
        .assert()
        .success();
}

#[test]
fn grep_finds_marker() {
    let dir = fixtures_dir();
    let assert = bin()
        .current_dir(&dir)
        .args(["grep", "MARKER_NEEDLE"])
        .assert()
        .success();
    let out = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    assert!(
        out.contains("MARKER_NEEDLE"),
        "expected marker in grep output, got: {}",
        out
    );
    // At least the .txt fixture should match.
    assert!(
        out.lines().any(|l| l.starts_with("notes.txt:")),
        "expected notes.txt hit in grep output, got: {}",
        out
    );
}

#[test]
fn grep_glob_filter_restricts_files() {
    let dir = fixtures_dir();
    let assert = bin()
        .current_dir(&dir)
        .args(["grep", "MARKER_NEEDLE", "--glob", "*.txt"])
        .assert()
        .success();
    let out = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    // No .rs hits should appear when filtered to *.txt
    assert!(
        !out.lines().any(|l| l.starts_with("sample.rs:")),
        "rs file leaked past glob filter: {}",
        out
    );
}

#[test]
fn symbols_extracts_rust_decls() {
    let dir = fixtures_dir();
    let assert = bin()
        .current_dir(&dir)
        .args(["symbols", "sample.rs"])
        .assert()
        .success();
    let out = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    let has = |needle: &str| out.lines().any(|l| l.starts_with(needle));
    assert!(has("struct:Widget:"), "missing struct Widget: {}", out);
    assert!(has("enum:Shape:"), "missing enum Shape: {}", out);
    assert!(has("trait:Draw:"), "missing trait Draw: {}", out);
    assert!(has("fn:make_widget:"), "missing fn make_widget: {}", out);
}

#[test]
fn symbols_extracts_typescript_decls() {
    let dir = fixtures_dir();
    let assert = bin()
        .current_dir(&dir)
        .args(["symbols", "sample.ts"])
        .assert()
        .success();
    let out = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    assert!(
        out.lines().any(|l| l.starts_with("class:Runner:")),
        "missing class Runner: {}",
        out
    );
    assert!(
        out.lines().any(|l| l.starts_with("function:helper:")),
        "missing function helper: {}",
        out
    );
    assert!(
        out.lines().any(|l| l.starts_with("interface:Options:")),
        "missing interface Options: {}",
        out
    );
}

#[test]
fn stat_emits_json() {
    let dir = fixtures_dir();
    let assert = bin()
        .current_dir(&dir)
        .args(["stat", "notes.txt"])
        .assert()
        .success();
    let out = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    let trimmed = out.trim();
    assert!(trimmed.starts_with('{') && trimmed.ends_with('}'), "not json: {}", trimmed);
    assert!(trimmed.contains("\"path\":\"notes.txt\""), "path key wrong: {}", trimmed);
    assert!(trimmed.contains("\"bytes\":"), "bytes key missing: {}", trimmed);
    assert!(trimmed.contains("\"lines\":3"), "lines should be 3: {}", trimmed);
}

#[test]
fn stat_missing_file_exits_two() {
    let dir = fixtures_dir();
    bin()
        .current_dir(&dir)
        .args(["stat", "does-not-exist.txt"])
        .assert()
        .code(2);
}

#[test]
fn unknown_subcommand_exits_one() {
    bin().arg("frobnicate").assert().code(1);
}
