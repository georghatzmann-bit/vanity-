// Eine Freigabe ist nicht klonbar.
use aegis_core::consent::Approval;

fn duplicate(approval: Approval) -> (Approval, Approval) {
    let copy = approval.clone();
    (approval, copy)
}

fn main() {
    let _ = duplicate;
}
