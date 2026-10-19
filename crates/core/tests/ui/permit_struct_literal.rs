// Eine Ausführungserlaubnis kann nicht per Struct-Literal erzeugt werden.
use aegis_core::consent::ExecutionPermit;

fn main() {
    let _forged = ExecutionPermit {};
}
