//! The paused helper processes of one Fortnite instance (FortniteLauncher.exe and
//! FortniteClient-Win64-Shipping_EAC.exe). They never run – the old build only checks that
//! they exist – but they must be closed together with the game.
//!
//! The list is shared between the running instance ("Stop all") and the thread that waits for
//! the game to close. Whoever closes them first takes the list, so each PID is closed only once
//! (a closed PID can later belong to some other program).

use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Default)]
pub struct HelperPids(Arc<Mutex<Vec<u32>>>);

impl HelperPids {
    pub fn new(pids: Vec<u32>) -> Self {
        HelperPids(Arc::new(Mutex::new(pids)))
    }

    /// Takes all PIDs out (for closing them). Later calls, also on clones, get an empty list.
    pub fn take(&self) -> Vec<u32> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }

    pub fn is_empty(&self) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pids_are_handed_out_once_across_clones() {
        let helpers = HelperPids::new(vec![11, 22]);
        let watcher = helpers.clone();
        assert!(!watcher.is_empty());
        assert_eq!(helpers.take(), vec![11, 22]);
        // "Stop all" took them – the exit watcher must not close them again
        assert!(watcher.take().is_empty());
        assert!(helpers.is_empty() && watcher.is_empty());
    }

    #[test]
    fn empty_list_is_fine() {
        let helpers = HelperPids::default();
        assert!(helpers.is_empty());
        assert!(helpers.take().is_empty());
    }
}
