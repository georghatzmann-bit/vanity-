//! Log lines from before the UI listens.
//!
//! The launcher writes some lines while it starts (e.g. "Copied your settings from Vanity to
//! Rift …"), before the UI has subscribed to the live log. A Tauri event sent then is lost.
//! So lines are kept here until the UI asks for them once (`pending_log_lines`); after that
//! every line goes straight to the UI.

use std::sync::Mutex;

/// At most this many lines wait for the UI. Later ones are dropped (the first lines matter most).
pub const MAX_WAITING_LINES: usize = 500;

/// Holds lines until `take` is called once; from then on `hold` gives every line back to send.
pub struct EarlyLines<T> {
    /// `Some` = the UI hasn't asked yet, lines wait here. `None` = send lines right away.
    waiting: Mutex<Option<Vec<T>>>,
}

impl<T> Default for EarlyLines<T> {
    fn default() -> Self {
        EarlyLines { waiting: Mutex::new(Some(Vec::new())) }
    }
}

impl<T> EarlyLines<T> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Keeps the line while the UI hasn't asked yet. Returns it back if it should be sent now.
    pub fn hold(&self, line: T) -> Option<T> {
        let mut waiting = self.waiting.lock().unwrap_or_else(|e| e.into_inner());
        match waiting.as_mut() {
            Some(lines) => {
                if lines.len() < MAX_WAITING_LINES {
                    lines.push(line);
                }
                None
            }
            None => Some(line),
        }
    }

    /// Hands over all waiting lines (oldest first) and stops holding new ones.
    /// Only the first call returns lines; later calls return an empty list.
    pub fn take(&self) -> Vec<T> {
        let mut waiting = self.waiting.lock().unwrap_or_else(|e| e.into_inner());
        waiting.take().unwrap_or_default()
    }

    /// True while lines are still held back.
    pub fn is_holding(&self) -> bool {
        self.waiting.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_wait_until_taken_then_pass_through() {
        let early = EarlyLines::new();
        assert!(early.is_holding());
        assert_eq!(early.hold("copied settings"), None);
        assert_eq!(early.hold("port note"), None);
        assert_eq!(early.take(), vec!["copied settings", "port note"]);
        assert!(!early.is_holding());
        // from now on lines go out right away
        assert_eq!(early.hold("live"), Some("live"));
        // only the first take returns anything
        assert!(early.take().is_empty());
    }

    #[test]
    fn take_with_nothing_waiting_is_empty() {
        let early: EarlyLines<String> = EarlyLines::new();
        assert!(early.take().is_empty());
        assert_eq!(early.hold("x".to_string()), Some("x".to_string()));
    }

    #[test]
    fn keeps_the_first_lines_when_full() {
        let early = EarlyLines::new();
        for i in 0..MAX_WAITING_LINES + 10 {
            assert_eq!(early.hold(i), None);
        }
        let lines = early.take();
        assert_eq!(lines.len(), MAX_WAITING_LINES);
        assert_eq!(lines[0], 0);
        assert_eq!(*lines.last().unwrap(), MAX_WAITING_LINES - 1);
    }
}
