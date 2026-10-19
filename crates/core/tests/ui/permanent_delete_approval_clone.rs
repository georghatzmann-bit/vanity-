// Die Freigabe für endgültiges Löschen ist nicht klonbar.
use aegis_core::consent::PermanentDeleteApproval;

fn duplicate(approval: PermanentDeleteApproval) -> (PermanentDeleteApproval, PermanentDeleteApproval) {
    let copy = approval.clone();
    (approval, copy)
}

fn main() {
    let _ = duplicate;
}
