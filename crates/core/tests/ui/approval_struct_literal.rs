// Eine Freigabe kann nicht per Struct-Literal „gebastelt“ werden (private Felder).
use aegis_core::consent::Approval;

fn main() {
    let _forged = Approval {};
}
