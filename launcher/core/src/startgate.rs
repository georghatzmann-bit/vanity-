//! Cancelling a start, and closing Rift cleanly.
//!
//! "Host & Play" runs many steps one after the other, and some of them wait a long time (backend
//! ready, login seen in the log, server control pipe, game server listening). "Stop all" must stop
//! such a start for real: nothing new may be started after it, and every wait must end.
//!
//! - [`StartGate`] lives next to the running processes (behind the same lock). Every start step and
//!   every process start checks its [`StartToken`] there first. "Stop all" cancels all tokens.
//!   Closing Rift closes the gate for good: no token is valid any more.
//! - [`wait_for`] is the one wait loop: it ends when the thing is ready, the time is up, or the
//!   start was cancelled.
//! - [`Busy`] lists what still runs, for the "Close Rift?" question.
//! - [`ClosePrompt`] notices when the UI never shows that question (page error, WebView crashed or
//!   hangs): then Rift stops everything and quits by itself, so it can always be closed.

use std::time::{Duration, Instant};

/// Proof that a start (or a single action like "Join") still counts.
/// It turns invalid with the next "Stop all" or when Rift closes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartToken(u64);

/// Keeps track of the start in progress and of "Stop all".
#[derive(Debug, Default)]
pub struct StartGate {
    /// Goes up with every "Stop all": all tokens from before are cancelled.
    generation: u64,
    /// The "Host & Play" start that is still running (its generation), if any.
    in_progress: Option<u64>,
    /// Rift is closing: nothing may start any more.
    closed: bool,
}

impl StartGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// A token for a single action that "Stop all" should be able to cancel (e.g. "Join").
    /// It doesn't mark a start in progress.
    pub fn token(&self) -> StartToken {
        StartToken(self.generation)
    }

    /// "Host & Play" begins: marks a start in progress and returns its token.
    /// While Rift is closing, the token is cancelled right away.
    pub fn begin(&mut self) -> StartToken {
        if !self.closed {
            self.in_progress = Some(self.generation);
        }
        StartToken(self.generation)
    }

    /// True once "Stop all" ran after the token was made, or Rift is closing.
    pub fn is_cancelled(&self, token: StartToken) -> bool {
        self.closed || token.0 != self.generation
    }

    /// A start is still running (from "Host & Play" until the server is ready).
    pub fn in_progress(&self) -> bool {
        self.in_progress.is_some()
    }

    /// The start is done (the server is ready, or it failed). Only the start that is still
    /// current can end itself; a cancelled one changes nothing.
    pub fn finish(&mut self, token: StartToken) {
        if !self.is_cancelled(token) && self.in_progress == Some(token.0) {
            self.in_progress = None;
        }
    }

    /// "Stop all": cancels every token. Returns true if a start was still in progress
    /// (then the log says "Start cancelled.").
    pub fn cancel(&mut self) -> bool {
        self.generation += 1;
        self.in_progress.take().is_some()
    }

    /// Rift is closing: cancels everything and lets nothing start any more.
    /// Returns true if a start was still in progress.
    pub fn close(&mut self) -> bool {
        self.closed = true;
        self.cancel()
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }
}

/// How a wait ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wait {
    Ready,
    TimedOut,
    Cancelled,
}

/// Waits up to `timeout` until `ready()` is true, checking every `poll`.
/// Ends early (with [`Wait::Cancelled`]) as soon as `cancelled()` is true – it is checked first,
/// so a cancelled start never counts as ready. With a `ready` that is never true this is a sleep
/// that "Stop all" can cut short.
pub fn wait_for(
    timeout: Duration,
    poll: Duration,
    mut cancelled: impl FnMut() -> bool,
    mut ready: impl FnMut() -> bool,
) -> Wait {
    let start = Instant::now();
    loop {
        if cancelled() {
            return Wait::Cancelled;
        }
        if ready() {
            return Wait::Ready;
        }
        let elapsed = start.elapsed();
        if elapsed >= timeout {
            return Wait::TimedOut;
        }
        std::thread::sleep(poll.min(timeout - elapsed));
    }
}

/// What still runs when the user closes the window.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Busy {
    pub game: bool,
    pub server: bool,
    pub backend: bool,
    pub starting: bool,
}

impl Busy {
    /// Plain names for the "Close Rift?" question, e.g. `["Your game", "Game server", "Backend"]`.
    /// Empty = nothing runs, the window may close right away.
    pub fn names(&self) -> Vec<String> {
        let mut out = Vec::new();
        if self.game {
            out.push("Your game");
        }
        if self.server {
            out.push("Game server");
        }
        if self.backend {
            out.push("Backend");
        }
        if self.starting {
            out.push("Game start");
        }
        out.into_iter().map(String::from).collect()
    }
}

/// The "Close Rift?" question. Rust blocks the close and asks the UI; the UI says when it
/// shows the question. If it never does, Rust closes anyway (after stopping everything).
#[derive(Debug, Default)]
pub struct ClosePrompt {
    /// Number of the latest question (0 = none yet).
    last: u64,
    /// The UI showed the latest question.
    shown: bool,
}

impl ClosePrompt {
    pub fn new() -> Self {
        Self::default()
    }

    /// A close was blocked and the question is sent: returns its number.
    pub fn ask(&mut self) -> u64 {
        self.last += 1;
        self.shown = false;
        self.last
    }

    /// The UI shows question `id`. An older number changes nothing.
    pub fn shown(&mut self, id: u64) {
        if id == self.last {
            self.shown = true;
        }
    }

    /// True if `id` is still the latest question and the UI never showed it
    /// (then Rift stops everything and quits).
    pub fn unanswered(&self, id: u64) -> bool {
        id == self.last && !self.shown
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn stop_all_cancels_the_running_start_once() {
        let mut gate = StartGate::new();
        let token = gate.begin();
        assert!(gate.in_progress());
        assert!(!gate.is_cancelled(token));

        assert!(gate.cancel(), "a start was running");
        assert!(gate.is_cancelled(token));
        assert!(!gate.in_progress());
        // a second "Stop all" has nothing to cancel ("Start cancelled." only once)
        assert!(!gate.cancel());
        assert!(gate.is_cancelled(token));
    }

    #[test]
    fn a_new_start_after_stop_all_counts_again() {
        let mut gate = StartGate::new();
        let old = gate.begin();
        gate.cancel();
        let new = gate.begin();
        assert!(gate.is_cancelled(old), "the old start stays cancelled");
        assert!(!gate.is_cancelled(new));
        assert!(gate.in_progress());
    }

    #[test]
    fn a_finished_start_is_no_longer_in_progress_but_its_token_still_counts() {
        let mut gate = StartGate::new();
        let token = gate.begin();
        gate.finish(token);
        assert!(!gate.in_progress());
        // e.g. the DLL of the game may still load later
        assert!(!gate.is_cancelled(token));
        // "Stop all" after a finished start is a normal stop, not "Start cancelled."
        assert!(!gate.cancel());
        assert!(gate.is_cancelled(token));
    }

    #[test]
    fn a_cancelled_start_cannot_end_a_newer_one() {
        let mut gate = StartGate::new();
        let old = gate.begin();
        gate.cancel();
        let _new = gate.begin();
        gate.finish(old);
        assert!(gate.in_progress(), "the newer start is still running");
    }

    #[test]
    fn plain_tokens_dont_mark_a_start() {
        let mut gate = StartGate::new();
        let join = gate.token();
        assert!(!gate.in_progress());
        assert!(!gate.is_cancelled(join));
        assert!(!gate.cancel());
        assert!(gate.is_cancelled(join));
    }

    #[test]
    fn closing_cancels_everything_for_good() {
        let mut gate = StartGate::new();
        let token = gate.begin();
        assert!(gate.close(), "the start was still running");
        assert!(gate.is_closed());
        assert!(gate.is_cancelled(token));
        // nothing may start after closing
        let late = gate.begin();
        assert!(gate.is_cancelled(late));
        assert!(!gate.in_progress());
        assert!(gate.is_cancelled(gate.token()));
        // closing again is fine
        assert!(!gate.close());
    }

    #[test]
    fn wait_ends_when_ready() {
        let calls = Cell::new(0);
        let r = wait_for(
            Duration::from_secs(5),
            Duration::from_millis(1),
            || false,
            || {
                calls.set(calls.get() + 1);
                calls.get() >= 3
            },
        );
        assert_eq!(r, Wait::Ready);
        assert_eq!(calls.get(), 3);
    }

    #[test]
    fn wait_ends_when_cancelled_even_if_ready() {
        let r = wait_for(Duration::from_secs(5), Duration::from_millis(1), || true, || true);
        assert_eq!(r, Wait::Cancelled);
    }

    #[test]
    fn wait_is_cut_short_by_a_cancel_while_waiting() {
        let polls = Cell::new(0);
        let started = Instant::now();
        let r = wait_for(
            Duration::from_secs(30),
            Duration::from_millis(2),
            || {
                polls.set(polls.get() + 1);
                polls.get() > 5
            },
            || false,
        );
        assert_eq!(r, Wait::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn wait_times_out() {
        let started = Instant::now();
        let r = wait_for(Duration::from_millis(30), Duration::from_millis(5), || false, || false);
        assert_eq!(r, Wait::TimedOut);
        assert!(started.elapsed() >= Duration::from_millis(30));
    }

    #[test]
    fn zero_timeout_still_checks_once() {
        assert_eq!(wait_for(Duration::ZERO, Duration::from_millis(5), || false, || true), Wait::Ready);
        assert_eq!(wait_for(Duration::ZERO, Duration::from_millis(5), || false, || false), Wait::TimedOut);
    }

    #[test]
    fn close_prompt_shown_by_the_ui_keeps_niobium_open() {
        let mut prompt = ClosePrompt::new();
        let id = prompt.ask();
        assert!(prompt.unanswered(id));
        prompt.shown(id);
        assert!(!prompt.unanswered(id), "the user decides in the dialog");
    }

    #[test]
    fn close_prompt_never_shown_lets_niobium_close() {
        let mut prompt = ClosePrompt::new();
        let id = prompt.ask();
        assert!(prompt.unanswered(id));
        // a late answer for an older question doesn't count for the new one
        let newer = prompt.ask();
        prompt.shown(id);
        assert!(prompt.unanswered(newer));
        // the older question's timer does nothing: only the latest one counts
        assert!(!prompt.unanswered(id));
        prompt.shown(newer);
        assert!(!prompt.unanswered(newer));
        // asking again needs a new answer
        let third = prompt.ask();
        assert!(prompt.unanswered(third));
    }

    #[test]
    fn busy_names_for_the_close_question() {
        assert!(Busy::default().names().is_empty());
        let all = Busy { game: true, server: true, backend: true, starting: false };
        assert_eq!(all.names(), vec!["Your game", "Game server", "Backend"]);
        let early = Busy { backend: true, starting: true, ..Busy::default() };
        assert_eq!(early.names(), vec!["Backend", "Game start"]);
    }
}
