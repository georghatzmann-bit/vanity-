// Nach `complete` ist die Erlaubnis verbraucht – kein zweites Ausführen.
use aegis_core::audit::ExecutionResult;
use aegis_core::consent::ExecutionPermit;

fn execute_twice(permit: ExecutionPermit) {
    let _first = permit.complete(ExecutionResult::Succeeded);
    let _again = permit.plan();
}

fn main() {
    let _ = execute_twice;
}
