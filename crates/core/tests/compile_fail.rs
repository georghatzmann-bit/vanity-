//! Compile-Fail-Tests: Die Freigabe-Typen lassen sich außerhalb von `aegis-core` weder
//! erzeugen noch vervielfältigen, (de)serialisieren oder mehrfach verwenden.
//!
//! Erwartete Compiler-Ausgaben liegen in `tests/ui/*.stderr` (erzeugt mit
//! `TRYBUILD=overwrite`, jede Datei von Hand geprüft: Sie muss aus dem beabsichtigten Grund
//! fehlschlagen). Die Toolchain ist gepinnt (`rust-toolchain.toml`), weil sich
//! Fehlermeldungen zwischen Compiler-Versionen ändern.

#[test]
fn consent_tokens_cannot_be_forged_copied_or_reused() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/*.rs");
}
