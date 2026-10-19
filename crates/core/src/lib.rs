//! Gemeinsame Grundtypen der AEGIS Suite – die **Goldene Regel** als Typsystem.
//!
//! > Der Schutzbereich verändert, verschiebt, beendet oder löscht **nichts** ohne
//! > ausdrückliche Bestätigung des Nutzers. Ohne „Ja“ nur: scannen, melden, erklären.
//!
//! Dieses Crate setzt die Regel so um, dass der Compiler sie erzwingt:
//!
//! 1. Jede beabsichtigte Veränderung wird als [`plan::ActionPlan`] beschrieben
//!    (Was genau? Warum? Was passiert dann? Rückgängig wie?). Der Plan hat eine
//!    deterministische Prüfsumme ([`plan::PlanDigest`]).
//! 2. [`consent::ConsentGate::propose`] legt den Plan als „ausstehend“ ab. Ohne Antwort
//!    verfällt er – **Standard bei Nicht-Reaktion ist: nichts tun.**
//! 3. Nur die Nutzerentscheidung [`consent::Decision::Execute`] („Ja, ausführen“) für genau
//!    diesen Plan (gleiche ID, gleiche Prüfsumme, rechtzeitig) ergibt in
//!    [`consent::ConsentGate::decide`] eine [`consent::Approval`]. Diese ist weder kopier-
//!    noch klon- noch (de)serialisierbar und kann außerhalb dieses Crates nicht erzeugt werden.
//!    `decide` (und `confirm_second`) sind per `clippy.toml` gesperrt: Jeder Aufruf braucht
//!    eine Markierung `// aegis-consent: …` und einen Eintrag in der Allowlist – im Betrieb
//!    nur der Pipe-Handler des Dienstes, der die Antwort aus dem UI-Dialog weiterreicht.
//!    Kein anderer Code „entscheidet“ für den Nutzer, ohne dass es in Clippy und im Review
//!    auffällt (innerhalb eines Prozesses ist das die Grenze dessen, was Typen leisten).
//! 4. Die `Approval` wird **als Wert** beim ausstellenden Tor gegen eine
//!    [`consent::ExecutionPermit`] eingelöst (`approval.redeem(&plan, &mut gate)`) und dabei
//!    verbraucht. Ausführende Funktionen in anderen Crates verlangen eine `ExecutionPermit`
//!    als Wert – ohne „Ja“ gibt es keine. Die Erlaubnis enthält genau den freigegebenen
//!    Plan; Fristen prüft das Tor mit seiner versiegelten [`consent::Clock`] (im Betrieb nur
//!    die Systemuhr).
//! 5. Endgültiges Löschen verlangt zusätzlich eine zweite, zeitlich getrennte Bestätigung
//!    ([`consent::PermanentDeleteApproval`]), die nicht länger gilt als die erste Freigabe.
//! 6. Alles wird im fälschungserkennenden [`audit`]-Protokoll (Hash-Kette) festgehalten –
//!    auch abgewiesene Antworten, verweigertes Einlösen und nicht eingelöste Freigaben.
//! 7. Verändernde APIs (std und verbreitete Crates) sind per `clippy.toml` gesperrt; jede
//!    Ausnahme braucht einen Eintrag in `crates/core/mutation-allowlist.txt` (per Test
//!    `mutation_guard` erzwungen, der auch Umgehungen wie `cfg(not(clippy))`, versteckte
//!    Konfiguration und das Test-Feature im Produktivcode erkennt).
//!
//! Der Kern ist deterministisch und frei von Seiteneffekten: Außerhalb des Test-Moduls
//! `testing` (Feature `testing`, nur für Tests) gibt es keinen Datei- oder Netzwerkzugriff.
//! Das Prüfprotokoll schreibt in einen beliebigen [`std::io::Write`]; das Öffnen der Datei
//! ist Sache des Dienstes.
#![forbid(unsafe_code)]

mod canonical;

pub mod audit;
pub mod consent;
pub mod plan;
pub mod risk;
pub mod undo;

#[cfg(any(test, feature = "testing"))]
pub mod testing;

/// Wiederexport der verwendeten `time`-Version, damit alle Crates dieselben Zeittypen nutzen.
pub use time;
/// Wiederexport der verwendeten `uuid`-Version (für [`plan::PlanId::from_uuid`]).
pub use uuid;
