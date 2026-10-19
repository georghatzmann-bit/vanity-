// Eine Ausführungserlaubnis ist nicht klonbar.
use aegis_core::consent::ExecutionPermit;

fn duplicate(permit: ExecutionPermit) -> (ExecutionPermit, ExecutionPermit) {
    let copy = permit.clone();
    (permit, copy)
}

fn main() {
    let _ = duplicate;
}
