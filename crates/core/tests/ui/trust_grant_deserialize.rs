// Eine Vertrauens-Freigabe kann nicht über JSON eingeschleust werden.
use aegis_core::consent::TrustGrant;

fn main() {
    let injected: Result<TrustGrant, serde_json::Error> = serde_json::from_str("{}");
    drop(injected);
}
