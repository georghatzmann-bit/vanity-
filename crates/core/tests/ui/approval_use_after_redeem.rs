// Eine Freigabe wird beim Einlösen verbraucht und kann nicht zweimal verwendet werden.
use aegis_core::consent::{Approval, ExecutionPermit, SystemClock};
use aegis_core::plan::ActionPlan;

fn redeem_twice(approval: Approval, plan: &ActionPlan) -> Vec<ExecutionPermit> {
    let first = approval.redeem(plan, &SystemClock);
    let second = approval.redeem(plan, &SystemClock);
    [first, second].into_iter().flatten().collect()
}

fn main() {
    let _ = redeem_twice;
}
