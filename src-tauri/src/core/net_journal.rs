//! OrigamiVPN: a record in the app log of what the core and the connections did, for reports of
//! connections that break while the VPN is on (two players on one line, 18.11, whose log said
//! nothing). It writes the core's own warnings (an adapter that went away, a provider that failed),
//! how many connections failed, and every moment when most long connections closed at once, with
//! how many of them went past the VPN. Names of sites never go to the log: connection and DNS
//! errors are only counted.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use clash_verge_logging::{Type, logging};
use tokio::time::{self, Instant};

const TICK: Duration = Duration::from_secs(10);
const API_DEADLINE: Duration = Duration::from_secs(4);
// A connection open this long is one a program meant to keep (a game, a chat, a call).
const LONG: Duration = Duration::from_secs(60);
// At least this many long connections, and at least half of them, closing between two looks.
const MASS_CLOSE_MIN: usize = 5;
const CORE_LINES_PER_TICK: usize = 20;
// The core keeps this many last lines (LOGS_QUEUE_LEN in the service and in clash-verge-logging).
const CORE_RING_LEN: usize = 100;
const LINE_MAX: usize = 300;
// A line of how many connections are open, now and then, to compare against.
const SUMMARY_EVERY: u32 = 30;

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct CoreSummary {
    /// The core's warnings and errors other than single connections and names, as they are.
    pub lines: Vec<String>,
    pub skipped: usize,
    pub connection_errors: usize,
    pub direct_errors: usize,
    pub dns_errors: usize,
    /// The core wrote more than its buffer holds between two looks.
    pub overflow: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct MassClose {
    pub closed: usize,
    pub direct: usize,
    pub vpn: usize,
    pub long_before: usize,
    pub open: usize,
}

#[derive(Debug)]
struct Tracked {
    vpn: bool,
    since: Instant,
}

#[derive(Debug, Default)]
pub(crate) struct Journal {
    seen_lines: HashSet<String>,
    connections: HashMap<String, Tracked>,
}

fn quiet(line: &str) -> bool {
    line.contains("level=info") || line.contains("level=debug")
}

fn one_connection(line: &str) -> bool {
    line.contains("-->") || line.contains(" dial ")
}

impl Journal {
    /// The core keeps its last lines in a ring; only the ones not seen at the previous look count.
    pub(crate) fn core_lines(&mut self, lines: &[String]) -> CoreSummary {
        // A ring with no line in common with the previous look turned over only when it is full: after
        // a core restart it starts empty and is short.
        let mut summary = CoreSummary {
            overflow: !self.seen_lines.is_empty()
                && lines.len() >= CORE_RING_LEN
                && !lines.iter().any(|line| self.seen_lines.contains(line)),
            ..CoreSummary::default()
        };
        for line in lines.iter().filter(|line| !self.seen_lines.contains(*line)) {
            if quiet(line) {
                continue;
            }
            if one_connection(line) {
                summary.connection_errors += 1;
                if line.contains("DIRECT") {
                    summary.direct_errors += 1;
                }
            } else if line.contains("[DNS]") {
                summary.dns_errors += 1;
            } else if summary.lines.len() < CORE_LINES_PER_TICK {
                summary.lines.push(line.chars().take(LINE_MAX).collect());
            } else {
                summary.skipped += 1;
            }
        }
        self.seen_lines = lines.iter().cloned().collect();
        summary
    }

    /// What is open now, by id, and whether it goes through a server. None unless most long
    /// connections closed since the previous look.
    pub(crate) fn connections(&mut self, now: Instant, open: Vec<(String, bool)>) -> Option<MassClose> {
        let is_long = |tracked: &Tracked| now.saturating_duration_since(tracked.since) >= LONG;
        let long_before = self.connections.values().filter(|tracked| is_long(tracked)).count();
        let mut next = HashMap::with_capacity(open.len());
        for (id, vpn) in open {
            let since = self.connections.get(&id).map_or(now, |tracked| tracked.since);
            next.insert(id, Tracked { vpn, since });
        }
        let previous = std::mem::replace(&mut self.connections, next);
        let closed: Vec<bool> = previous
            .iter()
            .filter(|(id, tracked)| is_long(tracked) && !self.connections.contains_key(*id))
            .map(|(_, tracked)| tracked.vpn)
            .collect();
        if closed.len() < MASS_CLOSE_MIN || closed.len() * 2 < long_before {
            return None;
        }
        let vpn = closed.iter().filter(|vpn| **vpn).count();
        Some(MassClose {
            closed: closed.len(),
            direct: closed.len() - vpn,
            vpn,
            long_before,
            open: self.connections.len(),
        })
    }

    fn open_counts(&self) -> (usize, usize) {
        let vpn = self.connections.values().filter(|tracked| tracked.vpn).count();
        (self.connections.len(), self.connections.len() - vpn)
    }
}

fn write_core(summary: &CoreSummary) {
    for line in &summary.lines {
        logging!(info, Type::Core, "core: {line}");
    }
    if summary.skipped > 0 {
        logging!(info, Type::Core, "core: {} more lines like these", summary.skipped);
    }
    if summary.connection_errors > 0 || summary.dns_errors > 0 {
        logging!(
            info,
            Type::Core,
            "core: {} connection errors ({} of them direct), {} name errors",
            summary.connection_errors,
            summary.direct_errors,
            summary.dns_errors
        );
    }
    if summary.overflow {
        logging!(info, Type::Core, "core: wrote more than it keeps since the last look");
    }
}

/// Started with the link watch.
pub fn start() {
    crate::process::AsyncHandler::spawn(run);
}

async fn run() {
    use crate::core::{CoreManager, handle::Handle};

    let mut journal = Journal::default();
    let mut tick = time::interval(TICK);
    tick.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
    let mut looks = 0u32;
    loop {
        tick.tick().await;
        if Handle::global().is_exiting() {
            continue;
        }
        if let Ok(Ok(lines)) = time::timeout(API_DEADLINE, CoreManager::global().get_clash_logs()).await {
            write_core(&journal.core_lines(&lines));
        }
        let Ok(Ok(all)) = time::timeout(API_DEADLINE, Handle::mihomo().get_connections()).await else {
            continue;
        };
        let open = all
            .connections
            .unwrap_or_default()
            .into_iter()
            .map(|connection| {
                let vpn = crate::core::link_watch::through_vpn(&connection.chains);
                (connection.id, vpn)
            })
            .collect();
        if let Some(mass) = journal.connections(Instant::now(), open) {
            logging!(
                warn,
                Type::Core,
                "connections: {} long ones closed at once ({} direct, {} through the VPN) of {}; {} open now",
                mass.closed,
                mass.direct,
                mass.vpn,
                mass.long_before,
                mass.open
            );
        }
        looks += 1;
        if looks.is_multiple_of(SUMMARY_EVERY) {
            let (open, direct) = journal.open_counts();
            logging!(info, Type::Core, "connections: {open} open, {direct} of them direct");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(texts: &[&str]) -> Vec<String> {
        texts.iter().map(|text| (*text).to_owned()).collect()
    }

    #[test]
    fn writes_the_core_warnings_once_and_only_counts_sites() {
        let mut journal = Journal::default();
        let first = lines(&[
            r#"time="1" level=info msg="[TCP] 192.168.0.101:5000 --> eu.battle.net:1119 match Games using DIRECT""#,
            r#"time="2" level=warning msg="[TUN] default interface changed by monitor, => Ethernet""#,
            r#"time="3" level=warning msg="[TCP] dial DIRECT (match RuleSet/games) 192.168.0.101:5001 --> eu.battle.net:1119 error: connect: timeout""#,
            r#"time="4" level=warning msg="[TCP] dial Proxy (match Match/) 192.168.0.101:5002 --> example.org:443 error: EOF""#,
            r#"time="5" level=warning msg="[DNS] resolve example.org A error: timeout""#,
        ]);
        let summary = journal.core_lines(&first);
        assert_eq!(
            summary.lines,
            lines(&[r#"time="2" level=warning msg="[TUN] default interface changed by monitor, => Ethernet""#])
        );
        assert_eq!(summary.connection_errors, 2);
        assert_eq!(summary.direct_errors, 1);
        assert_eq!(summary.dns_errors, 1);
        assert!(!summary.overflow);
        assert!(
            summary.lines.iter().all(|line| !line.contains("example.org")),
            "names of sites never go to the log"
        );

        // The same ring a moment later with one new line: only that one.
        let mut second = first.clone();
        second.push(r#"time="6" level=error msg="[TUN] default interface lost by monitor""#.to_owned());
        let summary = journal.core_lines(&second);
        assert_eq!(
            summary.lines,
            lines(&[r#"time="6" level=error msg="[TUN] default interface lost by monitor""#])
        );
        assert_eq!(summary.connection_errors, 0);
    }

    fn full_ring(from: usize) -> Vec<String> {
        (from..from + CORE_RING_LEN)
            .map(|i| format!(r#"time="{i}" level=warning msg="line {i}""#))
            .collect()
    }

    #[test]
    fn says_when_the_ring_turned_over_between_two_looks() {
        let mut journal = Journal::default();
        journal.core_lines(&full_ring(0));
        let summary = journal.core_lines(&full_ring(500));
        assert!(summary.overflow);
    }

    #[test]
    fn a_core_restart_is_not_an_overflow() {
        // Windows VM, 18.11: after the core restarted its ring started empty, shared no line with
        // the previous look, and the log said "wrote more than it keeps" for a few lines.
        let mut journal = Journal::default();
        journal.core_lines(&lines(&[
            r#"time="1" level=warning msg="a""#,
            r#"time="2" level=warning msg="b""#,
        ]));
        let summary = journal.core_lines(&lines(&[
            r#"time="9" level=warning msg="[TUN] default interface changed""#,
        ]));
        assert!(!summary.overflow);
        assert_eq!(summary.lines.len(), 1);
    }

    fn open(range: std::ops::Range<u32>, vpn: bool) -> Vec<(String, bool)> {
        range.map(|i| (format!("c{i}"), vpn)).collect()
    }

    #[test]
    fn most_long_connections_closing_at_once_is_recorded() {
        let start = Instant::now();
        let mut journal = Journal::default();
        let mut all = open(0..6, false);
        all.extend(open(6..10, true));
        assert_eq!(journal.connections(start, all.clone()), None);
        assert_eq!(journal.connections(start + LONG, all), None);
        // All ten long ones gone, two new ones opened right after.
        let mass = journal.connections(start + LONG + TICK, open(20..22, true));
        assert_eq!(
            mass,
            Some(MassClose {
                closed: 10,
                direct: 6,
                vpn: 4,
                long_before: 10,
                open: 2,
            })
        );
    }

    #[test]
    fn short_connections_coming_and_going_are_not_a_mass_close() {
        // A browser opens and closes dozens of connections a minute.
        let start = Instant::now();
        let mut journal = Journal::default();
        let mut long = open(0..10, false);
        journal.connections(start, long.clone());
        let mut now = start + LONG;
        long.extend(open(100..140, true));
        assert_eq!(journal.connections(now, long), None);
        now += TICK;
        assert_eq!(journal.connections(now, open(0..10, false)), None);
        // A few long ones closing is ordinary too.
        now += TICK;
        assert_eq!(journal.connections(now, open(0..7, false)), None);
    }
}
