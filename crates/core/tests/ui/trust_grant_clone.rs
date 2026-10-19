// Eine Vertrauens-Freigabe ist nicht klonbar.
use aegis_core::consent::TrustGrant;

fn duplicate(grant: TrustGrant) -> (TrustGrant, TrustGrant) {
    let copy = grant.clone();
    (grant, copy)
}

fn main() {
    let _ = duplicate;
}
