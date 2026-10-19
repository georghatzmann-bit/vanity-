// Eine Freigabe kann nicht über Pipe/Datei (JSON) eingeschleust werden.
use aegis_core::consent::Approval;

fn main() {
    let injected: Result<Approval, serde_json::Error> = serde_json::from_str("{}");
    drop(injected);
}
