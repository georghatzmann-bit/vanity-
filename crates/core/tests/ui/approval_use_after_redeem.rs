// Eine Freigabe wird beim Einlösen verbraucht und kann nicht zweimal verwendet werden.
use aegis_core::consent::{Approval, ConsentGate, ExecutionPermit};
use aegis_core::plan::ActionPlan;

fn redeem_twice(approval: Approval, plan: &ActionPlan, gate: &mut ConsentGate) -> Vec<ExecutionPermit> {
    let first = approval.redeem(plan, gate);
    let second = approval.redeem(plan, gate);
    [first, second].into_iter().flatten().collect()
}

fn main() {
    let _ = redeem_twice;
}
