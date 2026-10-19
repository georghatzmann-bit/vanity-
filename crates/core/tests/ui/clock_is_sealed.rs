// Eine eigene Uhr (z. B. mit erfundener Zeit) lässt sich außerhalb von aegis-core nicht bauen –
// Fristen beim Einlösen einer Freigabe können so nicht umgangen werden.
use aegis_core::consent::Clock;
use aegis_core::time::OffsetDateTime;

struct FrozenClock;

impl Clock for FrozenClock {
    fn now(&self) -> OffsetDateTime {
        OffsetDateTime::UNIX_EPOCH
    }
}

fn main() {}
