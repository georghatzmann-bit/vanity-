//! Energiepläne über `powercfg` (funktioniert ohne Adminrechte). Die Ausgabe wird unabhängig von der
//! Sprache gelesen: GUID, Name in Klammern, `*` markiert den aktiven Plan.
#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(windows)]
use super::shell;
use super::types::PowerPlan;
use crate::error::CmdResult;

/// „Ultimative Leistung“ (versteckter Plan, auf vielen Systemen nicht gelistet).
pub const ULTIMATE: &str = "e9a42b02-d5df-448d-aa00-03f14749eb61";
/// „Höchstleistung“.
pub const HIGH: &str = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c";
/// „Ausbalanciert“ (Windows-Standard).
pub const BALANCED: &str = "381b4222-f694-41f0-9685-ff5bb260df2e";

/// Namen der Leistungspläne (Deutsch/Englisch), falls ein Plan als Kopie mit neuer GUID existiert.
const PERFORMANCE_NAMES: [&str; 4] = ["höchstleistung", "high performance", "ultimative leistung", "ultimate performance"];

// =============================================================================================
// GUID
// =============================================================================================

/// Ist `s` eine GUID im Format `8-4-4-4-12` (Hexziffern, ohne Klammern)?
pub fn is_guid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    b.iter().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => *c == b'-',
        _ => c.is_ascii_hexdigit(),
    })
}

/// GUID prüfen und in Kleinbuchstaben liefern (auch mit `{}` oder Leerzeichen am Rand).
pub fn normalize_guid(s: &str) -> CmdResult<String> {
    let t = s.trim().trim_start_matches('{').trim_end_matches('}');
    if is_guid(t) {
        Ok(t.to_ascii_lowercase())
    } else {
        Err("Ungültige Energieplan-GUID.".into())
    }
}

/// Erste GUID in einer Zeile: Position (Byte) und GUID in Kleinbuchstaben.
pub fn find_guid(line: &str) -> Option<(usize, String)> {
    let b = line.as_bytes();
    if b.len() < 36 {
        return None;
    }
    (0..=b.len() - 36).find_map(|i| {
        // Nur ASCII-Treffer; ein Hex-Zeichen am Anfang ist immer eine Zeichengrenze
        let slice = line.get(i..i + 36)?;
        is_guid(slice).then(|| (i, slice.to_ascii_lowercase()))
    })
}

// =============================================================================================
// Ausgabe lesen
// =============================================================================================

/// Liest `powercfg /list`. Zeilen ohne GUID (Überschriften, Trennlinien) werden ignoriert.
pub fn parse_list(output: &str) -> Vec<PowerPlan> {
    let mut plans: Vec<PowerPlan> = Vec::new();
    for line in output.lines() {
        let Some((pos, guid)) = find_guid(line) else { continue };
        let rest = &line[pos + 36..];
        let (name, tail) = match (rest.find('('), rest.rfind(')')) {
            (Some(open), Some(close)) if close > open => {
                (rest[open + 1..close].trim().to_string(), &rest[close + 1..])
            }
            _ => (String::new(), rest),
        };
        let active = tail.contains('*');
        if plans.iter().any(|p| p.guid == guid) {
            continue;
        }
        plans.push(PowerPlan {
            guid,
            name: if name.is_empty() { "Energieplan".into() } else { name },
            active,
        });
    }
    plans
}

/// Neue GUID aus der Ausgabe von `powercfg /duplicatescheme`.
pub fn parse_new_guid(output: &str) -> Option<String> {
    output.lines().find_map(|l| find_guid(l).map(|(_, g)| g))
}

/// Der aktive Plan einer Liste.
pub fn active(plans: &[PowerPlan]) -> Option<&PowerPlan> {
    plans.iter().find(|p| p.active)
}

/// Gilt der Plan als Leistungsplan („Höchstleistung“ oder „Ultimative Leistung“)? Erkannt an der
/// GUID oder – bei Kopien mit eigener GUID – am Namen.
pub fn is_performance(plan: &PowerPlan) -> bool {
    if plan.guid == ULTIMATE || plan.guid == HIGH {
        return true;
    }
    let name = plan.name.trim().to_lowercase();
    PERFORMANCE_NAMES.iter().any(|n| name.starts_with(n))
}

// =============================================================================================
// powercfg ausführen
// =============================================================================================

/// Energiepläne lesen und setzen – als Schnittstelle, damit die Logik ohne Windows testbar ist.
pub trait PowerCfg {
    fn list(&self) -> CmdResult<Vec<PowerPlan>>;
    fn set_active(&self, guid: &str) -> CmdResult<()>;
    /// Legt eine Kopie des Plans an und liefert die neue GUID.
    fn duplicate(&self, guid: &str) -> CmdResult<String>;
}

/// Wählt den besten Leistungsplan (Ultimative Leistung vor Höchstleistung), legt „Höchstleistung“
/// bei Bedarf als Kopie an und aktiviert ihn. Liefert den aktivierten Plan.
pub fn activate_performance(power: &dyn PowerCfg, plans: &[PowerPlan]) -> CmdResult<PowerPlan> {
    let pick = plans
        .iter()
        .find(|p| p.guid == ULTIMATE)
        .or_else(|| plans.iter().find(|p| p.guid == HIGH))
        .or_else(|| plans.iter().find(|p| is_performance(p)))
        .cloned();
    let plan = match pick {
        Some(p) => p,
        None => {
            let guid = power.duplicate(HIGH).map_err(|e| {
                format!("Der Energieplan „Höchstleistung“ fehlt und konnte nicht angelegt werden: {e}")
            })?;
            // Echten (lokalisierten) Namen der Kopie nachlesen, sonst deutscher Standardname
            let name = power
                .list()
                .ok()
                .and_then(|l| l.into_iter().find(|p| p.guid == guid))
                .map(|p| p.name)
                .unwrap_or_else(|| "Höchstleistung".into());
            PowerPlan { guid, name, active: false }
        }
    };
    power.set_active(&plan.guid)?;
    Ok(PowerPlan { active: true, ..plan })
}

/// `powercfg.exe` aus `System32`.
#[cfg(windows)]
pub struct PowerCfgCli;

#[cfg(windows)]
fn run_powercfg(args: &[&str]) -> CmdResult<shell::Output> {
    let out = shell::run_hidden("powercfg.exe", args)?;
    if out.success {
        Ok(out)
    } else {
        Err(format!("powercfg meldet: {}", out.message()))
    }
}

#[cfg(windows)]
impl PowerCfg for PowerCfgCli {
    fn list(&self) -> CmdResult<Vec<PowerPlan>> {
        let out = run_powercfg(&["/list"])?;
        let plans = parse_list(&out.stdout);
        if plans.is_empty() {
            return Err("Die Energiepläne konnten nicht gelesen werden.".into());
        }
        Ok(plans)
    }

    fn set_active(&self, guid: &str) -> CmdResult<()> {
        let g = normalize_guid(guid)?;
        run_powercfg(&["/setactive", &g])
            .map(|_| ())
            .map_err(|e| format!("Der Energieplan konnte nicht aktiviert werden. {e}"))
    }

    fn duplicate(&self, guid: &str) -> CmdResult<String> {
        let g = normalize_guid(guid)?;
        let out = run_powercfg(&["/duplicatescheme", &g])?;
        parse_new_guid(&out.stdout)
            .ok_or_else(|| "powercfg hat keine GUID für den neuen Energieplan geliefert.".into())
    }
}

// =============================================================================================
// Tests: powercfg im Speicher
// =============================================================================================

/// Energiepläne im Speicher. `duplicate` vergibt fortlaufende GUIDs.
#[cfg(test)]
#[derive(Default)]
pub struct MemPowerCfg {
    pub plans: std::cell::RefCell<Vec<PowerPlan>>,
    pub set_calls: std::cell::RefCell<Vec<String>>,
    pub fail: std::cell::Cell<bool>,
}

#[cfg(test)]
impl MemPowerCfg {
    pub fn with(plans: &[(&str, &str, bool)]) -> Self {
        let p = Self::default();
        *p.plans.borrow_mut() = plans
            .iter()
            .map(|(g, n, a)| PowerPlan { guid: g.to_string(), name: n.to_string(), active: *a })
            .collect();
        p
    }

    pub fn active_guid(&self) -> Option<String> {
        self.plans.borrow().iter().find(|p| p.active).map(|p| p.guid.clone())
    }
}

#[cfg(test)]
impl PowerCfg for MemPowerCfg {
    fn list(&self) -> CmdResult<Vec<PowerPlan>> {
        if self.fail.get() {
            return Err("powercfg fehlt (Test)".into());
        }
        Ok(self.plans.borrow().clone())
    }

    fn set_active(&self, guid: &str) -> CmdResult<()> {
        if self.fail.get() {
            return Err("powercfg fehlt (Test)".into());
        }
        let g = normalize_guid(guid)?;
        let mut plans = self.plans.borrow_mut();
        if !plans.iter().any(|p| p.guid == g) {
            return Err("powercfg meldet: Das Energieschema existiert nicht.".into());
        }
        for p in plans.iter_mut() {
            p.active = p.guid == g;
        }
        self.set_calls.borrow_mut().push(g);
        Ok(())
    }

    fn duplicate(&self, guid: &str) -> CmdResult<String> {
        if self.fail.get() {
            return Err("powercfg fehlt (Test)".into());
        }
        let n = self.plans.borrow().len() as u32 + 1;
        let new = format!("00000000-0000-0000-0000-{n:012x}");
        let name = if guid == HIGH { "High performance" } else { "Kopie" };
        self.plans.borrow_mut().push(PowerPlan { guid: new.clone(), name: name.into(), active: false });
        Ok(new)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EN: &str = "\r\nExisting Power Schemes (* Active)\r\n-----------------------------------\r\n\
Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced) *\r\n\
Power Scheme GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (High performance)\r\n\
Power Scheme GUID: a1841308-3541-4fab-bc81-f71556f20b4a  (Power saver)\r\n\r\n";

    const DE: &str = "\nVorhandene Energieschemas (* Aktiv)\n-----------------------------------\n\
GUID des Energieschemas: 381b4222-f694-41f0-9685-ff5bb260df2e  (Ausbalanciert)\n\
GUID des Energieschemas: 8C5E7FDA-E8BF-4A96-9A85-A6E23A8C635C  (Höchstleistung) *\n\
GUID des Energieschemas: e9a42b02-d5df-448d-aa00-03f14749eb61  (Ultimative Leistung)\n\
GUID des Energieschemas: 11111111-2222-3333-4444-555555555555  (Mein Plan (Spiele))\n";

    #[test]
    fn guid_validation() {
        assert!(is_guid(BALANCED));
        assert!(is_guid("8C5E7FDA-E8BF-4A96-9A85-A6E23A8C635C"));
        assert!(!is_guid("8c5e7fda-e8bf-4a96-9a85-a6e23a8c635"), "zu kurz");
        assert!(!is_guid("8c5e7fdaxe8bf-4a96-9a85-a6e23a8c635c"), "falscher Trenner");
        assert!(!is_guid("8c5e7fda-e8bf-4a96-9a85-a6e23a8c635g"), "kein Hex");
        assert!(!is_guid("{8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c}"));
        assert!(!is_guid(""));
        assert_eq!(normalize_guid(" {8C5E7FDA-E8BF-4A96-9A85-A6E23A8C635C} ").unwrap(), HIGH);
        assert!(normalize_guid("; del *").is_err());
        assert!(normalize_guid("8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c x").is_err(), "nichts anhängen");
    }

    #[test]
    fn find_guid_handles_umlauts_before_guid() {
        let (pos, g) = find_guid("Prüfung: E9A42B02-D5DF-448D-AA00-03F14749EB61 rest").unwrap();
        assert_eq!(g, ULTIMATE);
        assert_eq!(&"Prüfung: E9A42B02-D5DF-448D-AA00-03F14749EB61 rest"[pos..pos + 36].to_lowercase(), ULTIMATE);
        assert!(find_guid("kurz").is_none());
        assert!(find_guid("-----------------------------------").is_none());
    }

    #[test]
    fn parse_english_list() {
        let plans = parse_list(EN);
        assert_eq!(plans.len(), 3);
        assert_eq!(plans[0].guid, BALANCED);
        assert_eq!(plans[0].name, "Balanced");
        assert!(plans[0].active);
        assert_eq!(plans[1].guid, HIGH);
        assert_eq!(plans[1].name, "High performance");
        assert!(!plans[1].active);
        assert_eq!(plans[2].name, "Power saver");
        assert_eq!(active(&plans).map(|p| p.guid.as_str()), Some(BALANCED));
    }

    #[test]
    fn parse_german_list_with_uppercase_guid_and_nested_parens() {
        let plans = parse_list(DE);
        assert_eq!(plans.len(), 4);
        assert_eq!(plans[1].guid, HIGH, "GUID in Kleinbuchstaben");
        assert_eq!(plans[1].name, "Höchstleistung");
        assert!(plans[1].active);
        assert!(!plans[0].active);
        assert_eq!(plans[2].name, "Ultimative Leistung");
        assert_eq!(plans[3].name, "Mein Plan (Spiele)");
        assert!(!plans[3].active);
    }

    #[test]
    fn parse_tolerates_odd_lines() {
        let plans = parse_list("GUID: 381b4222-f694-41f0-9685-ff5bb260df2e *\nGUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Doppelt)\n\n");
        assert_eq!(plans.len(), 1, "doppelte GUID nur einmal");
        assert_eq!(plans[0].name, "Energieplan");
        assert!(plans[0].active);
        assert!(parse_list("").is_empty());
        assert!(parse_list("Der Befehl wurde nicht gefunden.").is_empty());
    }

    #[test]
    fn parse_duplicate_output() {
        assert_eq!(
            parse_new_guid("Power Scheme GUID: 3a5b1d5e-1111-2222-3333-444444444444  (High performance)\r\n"),
            Some("3a5b1d5e-1111-2222-3333-444444444444".into())
        );
        assert_eq!(parse_new_guid("Fehler: ungültiger Parameter"), None);
    }

    #[test]
    fn performance_detection() {
        let p = |g: &str, n: &str| PowerPlan { guid: g.into(), name: n.into(), active: false };
        assert!(is_performance(&p(HIGH, "irgendwas")));
        assert!(is_performance(&p(ULTIMATE, "")));
        assert!(is_performance(&p("11111111-2222-3333-4444-555555555555", "Höchstleistung")));
        assert!(is_performance(&p("11111111-2222-3333-4444-555555555555", "Ultimate Performance")));
        assert!(!is_performance(&p(BALANCED, "Ausbalanciert")));
        assert!(!is_performance(&p("11111111-2222-3333-4444-555555555555", "Mein Spieleplan")));
    }

    #[test]
    fn activate_prefers_ultimate_then_high() {
        let power = MemPowerCfg::with(&[(BALANCED, "Balanced", true), (HIGH, "High performance", false), (ULTIMATE, "Ultimate Performance", false)]);
        let plan = activate_performance(&power, &power.list().unwrap()).unwrap();
        assert_eq!(plan.guid, ULTIMATE);
        assert!(plan.active);
        assert_eq!(power.active_guid(), Some(ULTIMATE.into()));

        let power = MemPowerCfg::with(&[(BALANCED, "Balanced", true), (HIGH, "High performance", false)]);
        let plan = activate_performance(&power, &power.list().unwrap()).unwrap();
        assert_eq!(plan.guid, HIGH);
        assert_eq!(plan.name, "High performance");
    }

    #[test]
    fn activate_creates_high_performance_when_missing() {
        let power = MemPowerCfg::with(&[(BALANCED, "Balanced", true)]);
        let plan = activate_performance(&power, &power.list().unwrap()).unwrap();
        assert_ne!(plan.guid, HIGH, "Kopie hat eine neue GUID");
        assert!(is_guid(&plan.guid));
        assert_eq!(plan.name, "High performance", "Name der Kopie nachgelesen");
        assert_eq!(power.active_guid(), Some(plan.guid.clone()));
        assert_eq!(power.plans.borrow().len(), 2);
    }

    #[test]
    fn activate_reports_powercfg_failure() {
        let power = MemPowerCfg::with(&[(BALANCED, "Balanced", true)]);
        power.fail.set(true);
        let err = activate_performance(&power, &[]).unwrap_err();
        assert!(err.contains("Höchstleistung"), "{err}");
    }
}
