// Eine Freigabe kann nicht serialisiert (und so dupliziert) werden.
use aegis_core::consent::Approval;

fn leak(approval: &Approval) -> String {
    serde_json::to_string(approval).unwrap_or_default()
}

fn main() {
    let _ = leak;
}
