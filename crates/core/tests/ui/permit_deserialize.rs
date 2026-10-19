// Eine Ausführungserlaubnis kann nicht über JSON eingeschleust werden.
use aegis_core::consent::ExecutionPermit;

fn main() {
    let injected: Result<ExecutionPermit, serde_json::Error> = serde_json::from_str("{}");
    drop(injected);
}
