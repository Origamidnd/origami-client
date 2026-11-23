//! OrigamiVPN: keeps the VPN link working without the window.
//!
//! While the VPN is on this probes the link, tells the tray and the window what it found, and
//! recovers after a wake from sleep, a network change, and once shortly after start. It used to
//! live in the window, where a hidden window ran it on throttled timers and lightweight mode
//! stopped it altogether.

use std::{
    future::Future,
    net::Ipv4Addr,
    sync::atomic::{AtomicU8, Ordering},
    time::{Duration, SystemTime},
};

use clash_verge_logging::{Type, logging};
use tokio::time::{self, Instant, MissedTickBehavior};

const TICK: Duration = Duration::from_secs(15);
// A tick that comes this late by the wall clock means the computer was asleep.
const SLEEP_GAP: Duration = Duration::from_secs(60);
// Let Wi-Fi and the adapter settle before checking.
const SETTLE: Duration = Duration::from_secs(5);
const MIN_INTERVAL: Duration = Duration::from_secs(30);
// One check soon after start: a core left over from an install over a running app, or one that
// came up dead (VM 18.11, 1-2 minutes without internet), passes no traffic until it is restarted.
const STARTUP_CHECK: Duration = Duration::from_secs(15);
// While the VPN is on the link is probed all the time; a failed probe is repeated soon, and only
// the second failure in a row changes what the app says.
const LINK_PROBE: Duration = Duration::from_secs(30);
const LINK_CONFIRM: Duration = Duration::from_secs(10);
const LINK_FAILS: u32 = 2;
// Failed system name lookups in a row, with the core fine, before saying another VPN is in the way.
const DNS_FAILS: u32 = 2;
const SYSTEM_DNS_HOSTS: [&str; 2] = ["www.gstatic.com", "cp.cloudflare.com"];
const SYSTEM_DNS_DEADLINE: Duration = Duration::from_secs(4);
// Restarting the core recreates the network adapter, which cuts the UDP of a running game until
// the game is restarted, so it is the last resort. A silent core gets it at once. With the internet
// there and the VPN silent it waits a while and tries once: the server is most likely down, and
// restarting again and again only cuts whatever goes past the VPN. With no internet at all it would
// not help, so only a very long outage gets it, in case the core has hung in a way that looks like
// one. The pause then doubles after each attempt that fails.
const VPN_SILENT_RESTART: Duration = Duration::from_secs(5 * 60);
const NO_INTERNET_RESTART: Duration = Duration::from_secs(30 * 60);
const HANG_RETRY: Duration = Duration::from_secs(5 * 60);
const HANG_RETRY_MAX: Duration = Duration::from_secs(30 * 60);

const PROBE_URL: &str = "https://www.gstatic.com/generate_204";
// A subscription limited to Telegram (the grace period after it ends) passes nothing else, and for
// it the VPN works when Telegram does. Tried only after the first one failed.
const VPN_URLS: [&str; 2] = [PROBE_URL, "https://api.telegram.org"];
// Google for most of the world, Yandex for a network where Google is cut.
const DIRECT_URLS: [&str; 2] = [PROBE_URL, "https://ya.ru"];
const PROBE_TIMEOUT_MS: u32 = 6000;
const API_DEADLINE: Duration = Duration::from_secs(4);
// The request itself may hang when the core is frozen.
const PROBE_DEADLINE: Duration = Duration::from_millis(PROBE_TIMEOUT_MS as u64 + 3000);
// Anything slower counts as unreachable, as on the home screen.
const FAILED_DELAY_MS: u32 = 10_000;

/// What the last checks found while the VPN is on: traffic goes, the internet itself is gone, or
/// the internet is there but the VPN passes nothing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum LinkState {
    #[default]
    Ok,
    NoInternet,
    Down,
    /// Another VPN or virtual adapter takes the core's own traffic back into the TUN.
    Conflict,
}

impl LinkState {
    const fn to_u8(self) -> u8 {
        match self {
            Self::Ok => 0,
            Self::NoInternet => 1,
            Self::Down => 2,
            Self::Conflict => 3,
        }
    }

    const fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::NoInternet,
            2 => Self::Down,
            3 => Self::Conflict,
            _ => Self::Ok,
        }
    }
}

static STATE: AtomicU8 = AtomicU8::new(0);

/// The state the tray and a newly opened window show.
pub fn current() -> LinkState {
    LinkState::from_u8(STATE.load(Ordering::Relaxed))
}

/// Why a probe failed: the core does not answer, nothing goes even directly, or only the VPN fails.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    CoreSilent,
    NoInternet,
    VpnSilent,
    /// The core refuses its own traffic as a loop: another VPN or virtual adapter is in the way.
    Conflict,
}

// How far back the core log is read, and how many loop refusals there must be in it: one can be a
// single program that points at the proxy port itself.
const LOG_WINDOW: usize = 300;
const LOOPBACK_LINES: usize = 3;

/// Another VPN or virtual adapter (other Wintun drivers, phone link apps, VMware) can route the
/// core's own connections back into the TUN; mihomo then refuses them as a loop and every server
/// looks dead (CVR #8632, FlClash #3009).
pub(crate) fn loopback_conflict(logs: &[String]) -> bool {
    logs.iter()
        .rev()
        .take(LOG_WINDOW)
        .filter(|line| line.contains("reject loopback"))
        .count()
        >= LOOPBACK_LINES
}

// The core's own outbounds that do not leave through a server.
const PAST_THE_VPN: [&str; 4] = ["DIRECT", "REJECT", "REJECT-DROP", "PASS"];

/// The chain starts at the outbound the connection leaves through, then the groups that chose it.
pub(crate) fn through_vpn(chains: &[String]) -> bool {
    chains
        .first()
        .is_some_and(|outbound| !PAST_THE_VPN.contains(&outbound.as_str()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    Ok,
    Restarted,
    NoInternet,
    Failed,
    Conflict,
}

impl Outcome {
    const fn state(self) -> LinkState {
        match self {
            Self::Ok | Self::Restarted => LinkState::Ok,
            Self::NoInternet => LinkState::NoInternet,
            Self::Failed => LinkState::Down,
            Self::Conflict => LinkState::Conflict,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reason {
    Network,
    Startup,
    Hang,
}

impl Reason {
    const fn restarted_notice(self) -> &'static str {
        match self {
            Self::Network => "origami.recovery.restarted",
            Self::Startup => "origami.recovery.restartedStartup",
            Self::Hang => "origami.recovery.restartedHang",
        }
    }
}

/// Everything the watch needs from the outside, so tests can drive it.
pub(crate) trait Env: Send + Sync + 'static {
    fn connected(&self) -> impl Future<Output = bool> + Send;
    /// Through the group most traffic takes: the rules may send the probe's own site past the VPN.
    fn probe(&self) -> impl Future<Output = bool> + Send;
    /// Names resolve the way programs resolve them, through the system. True outside "whole
    /// computer" mode: there programs do not depend on our TUN for names.
    fn system_dns(&self) -> impl Future<Output = bool> + Send;
    fn diagnose(&self) -> impl Future<Output = Verdict> + Send;
    fn flush_dns(&self) -> impl Future<Output = ()> + Send;
    /// Only the connections through the VPN: the ones past it work on, games among them.
    fn close_connections(&self) -> impl Future<Output = ()> + Send;
    fn restart_core(&self) -> impl Future<Output = ()> + Send;
    fn publish(&self, state: LinkState) -> impl Future<Output = ()> + Send;
    fn notice(&self, key: &'static str);
    fn wall(&self) -> SystemTime;
    /// The computer's own IPv4 addresses, without the VPN adapter, sorted.
    fn network(&self) -> Vec<Ipv4Addr>;
    /// The names of the adapters that hold these addresses, for the log.
    fn adapters(&self, _addresses: &[Ipv4Addr]) -> Vec<String> {
        Vec::new()
    }
}

/// After a wake from sleep or a network change, DNS answers and old connections may point at the
/// previous network. This drops the DNS cache, and if the link through the core fails two checks
/// and the internet is there, closes the connections through the VPN (the ones past it go on),
/// checks again and restarts the core once.
/// Without internet it leaves everything alone: when the internet is back a running game goes on
/// by itself. `force` restarts the core anyway. With `vpn_silent_retry` off a silent VPN (internet
/// and core fine) is left alone: the full try was already made for this stretch.
async fn recover<E: Env>(env: &E, force: bool, vpn_silent_retry: bool) -> Outcome {
    // Only the DNS cache: fake-ip addresses do not depend on the network, are kept across restarts
    // (store-fake-ip), and a program that remembered one could no longer reach it after a flush.
    env.flush_dns().await;
    if env.probe().await {
        return Outcome::Ok;
    }
    let verdict = env.diagnose().await;
    if verdict == Verdict::NoInternet && !force {
        return Outcome::NoInternet;
    }
    // A loop can be the core's own lost interface binding (a restart cures it) or another VPN's
    // adapter (it comes back at once). One full try per stretch, as for a silent VPN.
    if verdict == Verdict::Conflict && !force && !vpn_silent_retry {
        return Outcome::Conflict;
    }
    if verdict == Verdict::VpnSilent && !force && !vpn_silent_retry {
        return Outcome::Failed;
    }
    if verdict != Verdict::CoreSilent {
        // A lossy line or a network still settling fails a single probe now and then, and cutting
        // every connection for it is what breaks the games (NECSTEL, 18.11). Checked once more first,
        // as the regular check does.
        if !force {
            time::sleep(LINK_CONFIRM).await;
            if env.probe().await {
                logging!(
                    info,
                    Type::Core,
                    "link watch: the VPN passed the second check, nothing cut"
                );
                return Outcome::Ok;
            }
        }
        logging!(
            info,
            Type::Core,
            "link watch: the VPN failed twice ({verdict:?}), closing its connections"
        );
        env.close_connections().await;
        time::sleep(SETTLE).await;
        if env.probe().await {
            return Outcome::Ok;
        }
    }
    env.restart_core().await;
    time::sleep(SETTLE).await;
    if env.probe().await {
        return Outcome::Restarted;
    }
    match env.diagnose().await {
        Verdict::NoInternet => Outcome::NoInternet,
        Verdict::Conflict => Outcome::Conflict,
        Verdict::CoreSilent | Verdict::VpnSilent => Outcome::Failed,
    }
}

#[derive(Clone, Copy, Debug)]
struct Pending {
    at: Instant,
    reason: Reason,
    force: bool,
    vpn_silent_retry: bool,
}

/// The decisions, apart from the waiting and the calls.
#[derive(Debug)]
struct Planner {
    state: LinkState,
    last_run: Option<Instant>,
    fails: u32,
    hang_retry: Duration,
    next_hang_run: Option<Instant>,
    no_internet_since: Option<Instant>,
    vpn_silent_since: Option<Instant>,
    // One restart per stretch of a silent VPN; the link working again starts a new stretch.
    vpn_silent_restarted: bool,
}

impl Planner {
    const fn new() -> Self {
        Self {
            state: LinkState::Ok,
            last_run: None,
            fails: 0,
            hang_retry: HANG_RETRY,
            next_hang_run: None,
            no_internet_since: None,
            vpn_silent_since: None,
            vpn_silent_restarted: false,
        }
    }

    /// Returns the new state when it changed.
    /// The core reaches its servers: whatever failed before is over, even if names do not resolve.
    const fn servers_reached(&mut self) {
        self.fails = 0;
        self.hang_retry = HANG_RETRY;
        self.next_hang_run = None;
        self.no_internet_since = None;
        self.vpn_silent_since = None;
        self.vpn_silent_restarted = false;
    }

    fn report(&mut self, state: LinkState) -> Option<LinkState> {
        if state == LinkState::Ok {
            self.servers_reached();
        }
        if state == self.state {
            return None;
        }
        self.state = state;
        Some(state)
    }

    // Decided now: the dead-server path marks the stretch right after scheduling its try.
    fn schedule(&self, reason: Reason, force: bool, now: Instant) -> Pending {
        Pending {
            at: now + SETTLE,
            reason,
            force,
            vpn_silent_retry: !self.vpn_silent_restarted,
        }
    }

    fn may_run(&mut self, now: Instant) -> bool {
        if self
            .last_run
            .is_some_and(|last| now.saturating_duration_since(last) < MIN_INTERVAL)
        {
            return false;
        }
        self.last_run = Some(now);
        true
    }

    const fn after_run(&mut self, outcome: Outcome) -> LinkState {
        // A full try that did not help: wake, network and start checks leave this stretch alone.
        if matches!(outcome, Outcome::Failed | Outcome::Conflict) {
            self.vpn_silent_restarted = true;
        }
        outcome.state()
    }

    /// True when this failure is confirmed and needs a diagnosis.
    const fn failed_probe(&mut self) -> bool {
        self.fails += 1;
        self.fails >= LINK_FAILS
    }

    fn try_hang_restart(&mut self, force: bool, now: Instant) -> Option<Pending> {
        if self.next_hang_run.is_some_and(|next| now < next) {
            return None;
        }
        self.next_hang_run = Some(now + self.hang_retry);
        self.hang_retry = (self.hang_retry * 2).min(HANG_RETRY_MAX);
        Some(self.schedule(Reason::Hang, force, now))
    }

    fn after_verdict(&mut self, verdict: Verdict, now: Instant) -> (LinkState, Option<Pending>) {
        match verdict {
            Verdict::NoInternet => {
                self.vpn_silent_since = None;
                let since = *self.no_internet_since.get_or_insert(now);
                let restart = if now.saturating_duration_since(since) >= NO_INTERNET_RESTART {
                    self.try_hang_restart(true, now)
                } else {
                    None
                };
                (LinkState::NoInternet, restart)
            }
            Verdict::CoreSilent => {
                self.no_internet_since = None;
                (LinkState::Down, self.try_hang_restart(false, now))
            }
            Verdict::Conflict => {
                self.no_internet_since = None;
                self.vpn_silent_since = None;
                let restart = if self.vpn_silent_restarted {
                    None
                } else {
                    self.try_hang_restart(false, now)
                };
                self.vpn_silent_restarted |= restart.is_some();
                // Until the restart had its say, it is an ordinary silent VPN: a loop it cures is
                // never shown as another VPN.
                let state = if restart.is_some() {
                    LinkState::Down
                } else {
                    LinkState::Conflict
                };
                (state, restart)
            }
            Verdict::VpnSilent => {
                self.no_internet_since = None;
                // Counted from here, so the VPN gets its time to come back after the internet does.
                let since = *self.vpn_silent_since.get_or_insert(now);
                let mut restart = None;
                if !self.vpn_silent_restarted && now.saturating_duration_since(since) >= VPN_SILENT_RESTART {
                    restart = self.try_hang_restart(false, now);
                    self.vpn_silent_restarted = restart.is_some();
                }
                (LinkState::Down, restart)
            }
        }
    }
}

/// True when any of the addresses passes, tried in order: a working first one costs no more checks.
async fn any_passes<'a, F, Fut>(urls: &'a [&'a str], check: F) -> bool
where
    F: Fn(&'a str) -> Fut,
    Fut: Future<Output = bool>,
{
    for url in urls {
        if check(url).await {
            return true;
        }
    }
    false
}

async fn until(at: Option<Instant>) {
    match at {
        Some(at) => time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

struct Watch<E> {
    env: E,
    planner: Planner,
    dns_fails: u32,
    pending: Option<Pending>,
    confirm: Option<Instant>,
    last_wall: SystemTime,
    network: Vec<Ipv4Addr>,
}

impl<E: Env> Watch<E> {
    async fn report(&mut self, state: LinkState) {
        if let Some(changed) = self.planner.report(state) {
            self.env.publish(changed).await;
        }
    }

    fn on_tick(&mut self) {
        let wall = self.env.wall();
        let slept = wall.duration_since(self.last_wall).is_ok_and(|gap| gap > SLEEP_GAP);
        self.last_wall = wall;
        // Like the browser's "online": an address that appeared, not one that went away. An adapter
        // that blinks (a virtual one, a second link) would otherwise send a check each time.
        let network = self.env.network();
        let added: Vec<Ipv4Addr> = network
            .iter()
            .copied()
            .filter(|address| !self.network.contains(address))
            .collect();
        self.network = network;
        if slept {
            logging!(info, Type::Core, "link watch: the computer woke from sleep");
        }
        if !added.is_empty() {
            let adapters = self.env.adapters(&added);
            logging!(
                info,
                Type::Core,
                "link watch: {} new address(es) on {:?}",
                added.len(),
                adapters
            );
        }
        if slept || !added.is_empty() {
            self.pending = Some(self.planner.schedule(Reason::Network, false, Instant::now()));
        }
    }

    /// The core reaches its servers, but programs may still be cut off: another VPN's TUN that took
    /// the default route breaks name lookups for them (Happ on Windows, 18.11). None while a first
    /// failed lookup waits for the next one: the state stays as it was.
    async fn servers_reached(&mut self) -> Option<LinkState> {
        self.planner.servers_reached();
        if self.env.system_dns().await {
            self.dns_fails = 0;
            return Some(LinkState::Ok);
        }
        self.dns_fails += 1;
        if self.dns_fails < DNS_FAILS {
            return None;
        }
        logging!(warn, Type::Core, "link watch: the core works, system name lookups fail");
        Some(LinkState::Conflict)
    }

    async fn check_link(&mut self) {
        self.confirm = None;
        if !self.env.connected().await {
            self.dns_fails = 0;
            self.report(LinkState::Ok).await;
            return;
        }
        if self.env.probe().await {
            if let Some(state) = self.servers_reached().await {
                self.report(state).await;
            }
            return;
        }
        self.dns_fails = 0;
        if !self.planner.failed_probe() {
            logging!(
                info,
                Type::Core,
                "link watch: a check through the VPN failed, again in 10 s"
            );
            self.confirm = Some(Instant::now() + LINK_CONFIRM);
            return;
        }
        let verdict = self.env.diagnose().await;
        // Once per stretch: in a long outage this would come every 30 s.
        if self.planner.fails == LINK_FAILS {
            logging!(
                info,
                Type::Core,
                "link watch: two checks through the VPN failed: {verdict:?}"
            );
        }
        let (state, restart) = self.planner.after_verdict(verdict, Instant::now());
        self.report(state).await;
        if restart.is_some() {
            self.pending = restart;
        }
    }

    async fn run_pending(&mut self, pending: Pending) {
        if !self.env.connected().await || !self.planner.may_run(Instant::now()) {
            return;
        }
        let outcome = recover(&self.env, pending.force, pending.vpn_silent_retry).await;
        logging!(
            info,
            Type::Core,
            "link watch: {:?} check (force {}, retry {}) -> {outcome:?}",
            pending.reason,
            pending.force,
            pending.vpn_silent_retry
        );
        let state = self.planner.after_run(outcome);
        // A passed probe here is not the whole answer either: names may still fail for programs.
        let state = if state == LinkState::Ok {
            self.servers_reached().await
        } else {
            Some(state)
        };
        if let Some(state) = state {
            self.report(state).await;
        }
        if outcome == Outcome::Restarted {
            self.env.notice(pending.reason.restarted_notice());
        }
    }

    async fn run(mut self) {
        let start = Instant::now();
        let mut tick = time::interval_at(start + TICK, TICK);
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut probe = time::interval_at(start + LINK_PROBE, LINK_PROBE);
        probe.set_missed_tick_behavior(MissedTickBehavior::Delay);
        self.pending = Some(Pending {
            at: start + STARTUP_CHECK + SETTLE,
            reason: Reason::Startup,
            force: false,
            vpn_silent_retry: true,
        });
        loop {
            let pending_at = self.pending.map(|pending| pending.at);
            let confirm_at = self.confirm;
            // After a wake every timer fires at once. The clock gap is checked before any work, since
            // the work moves the baseline and a probe that ran first would hide the sleep.
            tokio::select! {
                _ = tick.tick() => {
                    self.on_tick();
                    continue;
                }
                _ = probe.tick() => {
                    self.on_tick();
                    self.check_link().await;
                }
                () = until(confirm_at) => {
                    self.on_tick();
                    self.check_link().await;
                }
                () = until(pending_at) => {
                    let due = self.pending.take();
                    self.on_tick();
                    if let Some(due) = due {
                        self.run_pending(due).await;
                    }
                }
            }
            // A long check is not a sleep.
            self.last_wall = self.env.wall();
        }
    }
}

pub(crate) async fn watch<E: Env>(env: E) {
    let last_wall = env.wall();
    let network = env.network();
    Watch {
        env,
        planner: Planner::new(),
        dns_fails: 0,
        pending: None,
        confirm: None,
        last_wall,
        network,
    }
    .run()
    .await;
}

/// Started once the core is up.
// How often a clock warning looks whether the person has set the time right.
const CLOCK_RECHECK: Duration = Duration::from_secs(30);

pub fn start() {
    crate::process::AsyncHandler::spawn(|| watch(real::CoreEnv));
    crate::core::net_journal::start();
    crate::process::AsyncHandler::spawn(|| async {
        let mut every = time::interval(CLOCK_RECHECK);
        every.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            crate::config::recheck_clock_skew();
        }
    });
}

mod real {
    use super::{
        API_DEADLINE, DIRECT_URLS, Env, FAILED_DELAY_MS, LinkState, Ordering, PROBE_DEADLINE, PROBE_TIMEOUT_MS, STATE,
        SYSTEM_DNS_DEADLINE, SYSTEM_DNS_HOSTS, VPN_URLS, Verdict, any_passes, loopback_conflict, through_vpn,
    };
    use crate::{
        config::Config,
        core::{CoreManager, handle::Handle, notify::NoticeStatus},
    };
    use clash_verge_logging::{Type, logging};
    use network_interface::{Addr, NetworkInterface, NetworkInterfaceConfig as _};
    use std::{net::Ipv4Addr, time::SystemTime};
    use tauri_plugin_mihomo::models::ProxyType;
    use tokio::time;

    pub(super) struct CoreEnv;

    async fn passes(proxy: &str, url: &str) -> bool {
        matches!(
            time::timeout(
                PROBE_DEADLINE,
                Handle::mihomo().delay_proxy_by_name(proxy, url, PROBE_TIMEOUT_MS)
            )
            .await,
            Ok(Ok(result)) if result.delay > 0
        )
    }

    /// The group the home screen shows: the first visible selector, else the first visible group.
    async fn main_group() -> Option<String> {
        let view = crate::cmd::get_proxy_view().await.ok()?;
        let visible = |hidden: Option<bool>| !hidden.unwrap_or(false);
        view.groups
            .iter()
            .find(|group| visible(group.hidden) && group.proxy_type == ProxyType::Selector)
            .or_else(|| view.groups.iter().find(|group| visible(group.hidden)))
            .map(|group| group.name.clone())
    }

    // The VPN adapter's own range (Mihomo's default 198.18.0.1/30 lies in it): it comes and goes
    // with every core restart, which is not a network change.
    const fn is_vpn_adapter(address: Ipv4Addr) -> bool {
        let [a, b, ..] = address.octets();
        a == 198 && (b & 0xfe) == 18
    }

    impl Env for CoreEnv {
        async fn connected(&self) -> bool {
            // Nothing to watch, and above all nothing to restart, while the app is closing.
            if Handle::global().is_exiting() {
                return false;
            }
            let verge = Config::verge().await.latest_arc();
            let tun = verge.enable_tun_mode.unwrap_or(false) && crate::core::runstate::RUN_STATE.state().tun_capable();
            tun || verge.enable_system_proxy.unwrap_or(false)
        }

        async fn probe(&self) -> bool {
            match main_group().await {
                Some(group) => any_passes(&VPN_URLS, |url| passes(&group, url)).await,
                None => {
                    any_passes(&VPN_URLS, |url| async move {
                        matches!(
                            crate::feat::test_delay(url.into()).await,
                            Ok(delay) if delay > 0 && delay < FAILED_DELAY_MS
                        )
                    })
                    .await
                }
            }
        }

        async fn system_dns(&self) -> bool {
            let verge = Config::verge().await.latest_arc();
            let tun = verge.enable_tun_mode.unwrap_or(false) && crate::core::runstate::RUN_STATE.state().tun_capable();
            if !tun {
                return true;
            }
            // Only where the system's lookups must go through our TUN: Windows with strict-route
            // blocks port 53 past it. Elsewhere (Linux resolved, strict-route off) the system may ask
            // the router's DNS directly, and the answer would say nothing about another VPN.
            if !cfg!(target_os = "windows") {
                return true;
            }
            let strict = Config::clash()
                .await
                .latest_arc()
                .0
                .get("tun")
                .and_then(|tun| tun.get("strict-route"))
                .and_then(serde_yaml_ng::Value::as_bool)
                .unwrap_or(false);
            if !strict {
                return true;
            }
            // Through getaddrinfo, as any program: with our TUN in charge the answer comes from the
            // core at once (fake-ip). Two names, so one blocked or slow name does not decide.
            for host in SYSTEM_DNS_HOSTS {
                if let Ok(Ok(addrs)) = time::timeout(SYSTEM_DNS_DEADLINE, tokio::net::lookup_host((host, 443u16))).await
                    && addrs.count() > 0
                {
                    return true;
                }
            }
            false
        }

        async fn diagnose(&self) -> Verdict {
            if !matches!(
                time::timeout(API_DEADLINE, Handle::mihomo().get_version()).await,
                Ok(Ok(_))
            ) {
                return Verdict::CoreSilent;
            }
            // Before the direct check: in a loop the core's direct connections fail too, and that
            // would read as "no internet".
            let logs = CoreManager::global().get_clash_logs().await.unwrap_or_default();
            if loopback_conflict(&logs) {
                return Verdict::Conflict;
            }
            let direct = futures::future::join_all(DIRECT_URLS.iter().map(|url| passes("DIRECT", url))).await;
            if direct.contains(&true) {
                Verdict::VpnSilent
            } else {
                Verdict::NoInternet
            }
        }

        async fn flush_dns(&self) {
            let _ = time::timeout(API_DEADLINE, Handle::mihomo().flush_dns()).await;
        }

        async fn close_connections(&self) {
            let mihomo = Handle::mihomo();
            let connections = match time::timeout(API_DEADLINE, mihomo.get_connections()).await {
                Ok(Ok(connections)) => connections.connections.unwrap_or_default(),
                _ => {
                    logging!(
                        warn,
                        Type::Core,
                        "link watch: could not read the connections, none closed"
                    );
                    return;
                }
            };
            let through: Vec<&str> = connections
                .iter()
                .filter(|connection| through_vpn(&connection.chains))
                .map(|connection| connection.id.as_str())
                .collect();
            let _ = time::timeout(
                API_DEADLINE,
                futures::future::join_all(through.iter().map(|id| mihomo.close_connection(id))),
            )
            .await;
            logging!(
                info,
                Type::Core,
                "link watch: closed {} connections through the VPN, kept {} past it",
                through.len(),
                connections.len() - through.len()
            );
        }

        async fn restart_core(&self) {
            logging!(info, Type::Core, "link watch: restarting the core");
            match CoreManager::global().restart_core().await {
                Ok(()) => Handle::refresh_clash(),
                Err(error) => logging!(warn, Type::Core, "link watch: core restart failed: {error:#}"),
            }
        }

        async fn publish(&self, state: LinkState) {
            logging!(info, Type::Core, "link watch: link is now {state:?}");
            STATE.store(state.to_u8(), Ordering::Relaxed);
            crate::core::tray::show_link_state().await;
            Handle::notify_link_state(state);
        }

        fn notice(&self, key: &'static str) {
            Handle::notice(NoticeStatus::Info, key);
        }

        fn wall(&self) -> SystemTime {
            SystemTime::now()
        }

        fn network(&self) -> Vec<Ipv4Addr> {
            let mut addresses: Vec<Ipv4Addr> = NetworkInterface::show()
                .unwrap_or_default()
                .into_iter()
                .flat_map(|interface| interface.addr)
                .filter_map(|addr| match addr {
                    Addr::V4(v4) => Some(v4.ip),
                    Addr::V6(_) => None,
                })
                .filter(|ip| !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() && !is_vpn_adapter(*ip))
                .collect();
            addresses.sort_unstable();
            addresses.dedup();
            addresses
        }

        fn adapters(&self, addresses: &[Ipv4Addr]) -> Vec<String> {
            let mut names: Vec<String> = NetworkInterface::show()
                .unwrap_or_default()
                .into_iter()
                .filter(|interface| {
                    interface
                        .addr
                        .iter()
                        .any(|addr| matches!(addr, Addr::V4(v4) if addresses.contains(&v4.ip)))
                })
                .map(|interface| interface.name)
                .collect();
            names.dedup();
            names
        }
    }

    #[cfg(test)]
    mod tests {
        use super::is_vpn_adapter;
        use std::net::Ipv4Addr;

        #[test]
        fn the_vpn_adapter_range_is_not_the_network() {
            assert!(is_vpn_adapter(Ipv4Addr::new(198, 18, 0, 1)));
            assert!(is_vpn_adapter(Ipv4Addr::new(198, 19, 255, 254)));
            assert!(!is_vpn_adapter(Ipv4Addr::new(198, 20, 0, 1)));
            assert!(!is_vpn_adapter(Ipv4Addr::new(192, 168, 1, 5)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use std::sync::Arc;

    const MIN: Duration = Duration::from_secs(60);

    // What answers right now: the VPN through the group, the internet through DIRECT, and the core.
    #[derive(Debug)]
    struct Net {
        vpn: bool,
        internet: bool,
        core: bool,
        conflict: bool,
        restart_clears_conflict: bool,
        system_dns: bool,
        connected: bool,
        // A restart brings these back.
        restart_fixes_vpn: bool,
        restart_fixes_core: bool,
        wall_offset: Duration,
        network: Vec<Ipv4Addr>,
        // The next probes that fail anyway, as on a lossy line.
        failing_probes: u32,
    }

    #[derive(Debug, Default)]
    struct Calls {
        probes: u32,
        flushes: u32,
        restarts: u32,
        closes: u32,
        published: Vec<LinkState>,
        notices: Vec<&'static str>,
    }

    #[derive(Clone)]
    struct Fake {
        net: Arc<Mutex<Net>>,
        calls: Arc<Mutex<Calls>>,
        base: SystemTime,
        start: Instant,
    }

    impl Fake {
        fn new() -> Self {
            Self {
                net: Arc::new(Mutex::new(Net {
                    vpn: true,
                    internet: true,
                    core: true,
                    conflict: false,
                    restart_clears_conflict: false,
                    system_dns: true,
                    connected: true,
                    restart_fixes_vpn: false,
                    restart_fixes_core: false,
                    wall_offset: Duration::ZERO,
                    network: vec![Ipv4Addr::new(192, 168, 1, 5)],
                    failing_probes: 0,
                })),
                calls: Arc::new(Mutex::new(Calls::default())),
                base: SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000),
                start: Instant::now(),
            }
        }

        fn spawn(&self) -> tokio::task::JoinHandle<()> {
            tokio::spawn(watch(self.clone()))
        }

        fn restarts(&self) -> u32 {
            self.calls.lock().restarts
        }

        fn state(&self) -> LinkState {
            self.calls.lock().published.last().copied().unwrap_or_default()
        }
    }

    impl Env for Fake {
        async fn connected(&self) -> bool {
            self.net.lock().connected
        }

        async fn probe(&self) -> bool {
            self.calls.lock().probes += 1;
            let mut net = self.net.lock();
            if net.failing_probes > 0 {
                net.failing_probes -= 1;
                return false;
            }
            net.core && net.vpn && net.internet
        }

        async fn system_dns(&self) -> bool {
            self.net.lock().system_dns
        }

        async fn diagnose(&self) -> Verdict {
            let net = self.net.lock();
            if !net.core {
                Verdict::CoreSilent
            } else if net.conflict {
                Verdict::Conflict
            } else if net.internet {
                Verdict::VpnSilent
            } else {
                Verdict::NoInternet
            }
        }

        async fn flush_dns(&self) {
            self.calls.lock().flushes += 1;
        }

        async fn close_connections(&self) {
            self.calls.lock().closes += 1;
        }

        async fn restart_core(&self) {
            self.calls.lock().restarts += 1;
            let mut net = self.net.lock();
            if net.restart_fixes_vpn {
                net.vpn = true;
            }
            if net.restart_fixes_core {
                net.core = true;
            }
            if net.restart_clears_conflict {
                net.conflict = false;
            }
        }

        async fn publish(&self, state: LinkState) {
            self.calls.lock().published.push(state);
        }

        fn notice(&self, key: &'static str) {
            self.calls.lock().notices.push(key);
        }

        fn wall(&self) -> SystemTime {
            self.base + Instant::now().duration_since(self.start) + self.net.lock().wall_offset
        }

        fn network(&self) -> Vec<Ipv4Addr> {
            self.net.lock().network.clone()
        }
    }

    async fn advance(duration: Duration) {
        time::sleep(duration).await;
    }

    #[tokio::test(start_paused = true)]
    async fn checks_soon_after_start_and_restarts_a_core_that_came_up_dead() {
        // The core sometimes starts without passing traffic (VM 18.11); every second of that is a
        // dead internet for the person, so the first check comes early.
        let fake = Fake::new();
        {
            let mut net = fake.net.lock();
            net.vpn = false;
            net.restart_fixes_vpn = true;
        }
        let task = fake.spawn();
        advance(Duration::from_secs(10)).await;
        assert_eq!(fake.calls.lock().probes, 0);
        // Start check at 20 s, a second probe 10 s later, then the cut and the restart.
        advance(Duration::from_secs(35)).await;
        assert_eq!(fake.restarts(), 1);
        assert_eq!(fake.calls.lock().notices, vec!["origami.recovery.restartedStartup"]);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn skips_the_checks_while_the_vpn_is_off() {
        let fake = Fake::new();
        fake.net.lock().connected = false;
        fake.net.lock().vpn = false;
        let task = fake.spawn();
        advance(MIN * 3).await;
        assert_eq!(fake.calls.lock().probes, 0);
        assert_eq!(fake.restarts(), 0);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn says_there_is_no_internet_within_a_minute_and_clears_it_when_it_returns() {
        let fake = Fake::new();
        let task = fake.spawn();
        advance(Duration::from_secs(40)).await;
        fake.net.lock().internet = false;
        advance(Duration::from_secs(40)).await;
        assert_eq!(fake.state(), LinkState::NoInternet);
        fake.net.lock().internet = true;
        advance(Duration::from_secs(40)).await;
        assert_eq!(fake.state(), LinkState::Ok);
        assert_eq!(fake.calls.lock().published, vec![LinkState::NoInternet, LinkState::Ok]);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn does_not_restart_the_core_during_an_outage_of_20_minutes() {
        let fake = Fake::new();
        let task = fake.spawn();
        advance(Duration::from_secs(40)).await;
        fake.net.lock().internet = false;
        advance(MIN * 20).await;
        assert_eq!(fake.restarts(), 0);
        assert_eq!(fake.calls.lock().closes, 0);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn tries_a_restart_only_after_a_very_long_outage() {
        let fake = Fake::new();
        let task = fake.spawn();
        advance(Duration::from_secs(40)).await;
        fake.net.lock().internet = false;
        advance(MIN * 32).await;
        assert_eq!(fake.restarts(), 1);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn gives_the_vpn_time_after_the_internet_is_back_before_restarting() {
        let fake = Fake::new();
        let task = fake.spawn();
        advance(Duration::from_secs(40)).await;
        fake.net.lock().internet = false;
        advance(MIN * 5).await;
        {
            let mut net = fake.net.lock();
            net.internet = true;
            net.vpn = false;
        }
        advance(MIN * 2).await;
        assert_eq!(fake.state(), LinkState::Down);
        assert_eq!(fake.restarts(), 0);
        fake.net.lock().restart_fixes_vpn = true;
        advance(MIN * 5).await;
        assert_eq!(fake.restarts(), 1);
        assert_eq!(fake.calls.lock().notices, vec!["origami.recovery.restartedHang"]);
        assert_eq!(fake.state(), LinkState::Ok);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn restarts_a_frozen_core_within_a_minute_and_says_so() {
        let fake = Fake::new();
        let task = fake.spawn();
        advance(Duration::from_secs(40)).await;
        {
            let mut net = fake.net.lock();
            net.core = false;
            net.restart_fixes_core = true;
        }
        advance(MIN).await;
        assert_eq!(fake.restarts(), 1);
        // A silent core is restarted without cutting connections first.
        assert_eq!(fake.calls.lock().closes, 0);
        assert_eq!(fake.calls.lock().notices, vec!["origami.recovery.restartedHang"]);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn waits_longer_and_longer_between_restarts_while_the_core_stays_silent() {
        let fake = Fake::new();
        let task = fake.spawn();
        advance(Duration::from_secs(40)).await;
        fake.net.lock().core = false;
        // 25 minutes: attempts about 1, 6 and 16 minutes in, not one every few minutes.
        advance(MIN * 25).await;
        assert_eq!(fake.restarts(), 3);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn restarts_once_for_a_dead_server_not_again_and_again() {
        let fake = Fake::new();
        let task = fake.spawn();
        advance(Duration::from_secs(40)).await;
        // The chosen server is down, the internet and the core are fine: a restart cannot fix that
        // and every one cuts the game that goes past the VPN.
        fake.net.lock().vpn = false;
        advance(MIN * 180).await;
        assert_eq!(fake.restarts(), 1);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn tries_a_restart_again_after_the_link_worked_in_between() {
        let fake = Fake::new();
        let task = fake.spawn();
        advance(Duration::from_secs(40)).await;
        fake.net.lock().vpn = false;
        advance(MIN * 10).await;
        assert_eq!(fake.restarts(), 1);
        fake.net.lock().vpn = true;
        advance(MIN * 2).await;
        assert_eq!(fake.state(), LinkState::Ok);
        fake.net.lock().vpn = false;
        advance(MIN * 10).await;
        assert_eq!(fake.restarts(), 2);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn recovers_after_a_wake_from_sleep() {
        let fake = Fake::new();
        let task = fake.spawn();
        advance(MIN).await;
        assert_eq!(fake.restarts(), 0);
        // Asleep for an hour: the wall clock jumps, the server picked before sleep is gone.
        {
            let mut net = fake.net.lock();
            net.wall_offset = MIN * 60;
            net.vpn = false;
            net.restart_fixes_vpn = true;
        }
        advance(Duration::from_secs(35)).await;
        assert_eq!(fake.calls.lock().closes, 1);
        assert_eq!(fake.restarts(), 1);
        assert_eq!(fake.calls.lock().notices, vec!["origami.recovery.restarted"]);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn checks_after_a_network_change_and_leaves_a_working_link_alone() {
        let fake = Fake::new();
        let task = fake.spawn();
        advance(MIN).await;
        let flushes = fake.calls.lock().flushes;
        fake.net.lock().network = vec![Ipv4Addr::new(10, 0, 0, 7)];
        advance(Duration::from_secs(25)).await;
        // Only the DNS cache is dropped: the link still works.
        assert_eq!(fake.calls.lock().flushes, flushes + 1);
        assert_eq!(fake.calls.lock().closes, 0);
        assert_eq!(fake.restarts(), 0);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn one_failed_check_after_a_network_change_cuts_nothing() {
        // A lossy line (NECSTEL, 18.11): a new address and a probe that happens to fail. Closing the
        // connections and restarting the core for it cut games that went past the VPN.
        let fake = Fake::new();
        let task = fake.spawn();
        // Between the regular probes (every 30 s): the change is seen at 75 s, checked at 80 s.
        advance(Duration::from_secs(70)).await;
        let probes = fake.calls.lock().probes;
        {
            let mut net = fake.net.lock();
            net.network = vec![Ipv4Addr::new(192, 168, 1, 5), Ipv4Addr::new(10, 0, 0, 7)];
            net.failing_probes = 1;
        }
        advance(Duration::from_secs(12)).await;
        // The recovery's own probe failed (the regular one waits until 90 s).
        assert_eq!(fake.calls.lock().probes, probes + 1);
        assert_eq!(fake.net.lock().failing_probes, 0);
        advance(MIN).await;
        assert_eq!(fake.calls.lock().closes, 0);
        assert_eq!(fake.restarts(), 0);
        assert_eq!(fake.state(), LinkState::Ok);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn an_address_that_goes_away_is_not_a_network_change() {
        // A blinking second adapter: only its coming back is checked, not every blink twice.
        let fake = Fake::new();
        fake.net.lock().network = vec![Ipv4Addr::new(192, 168, 1, 5), Ipv4Addr::new(26, 1, 2, 3)];
        let task = fake.spawn();
        advance(MIN).await;
        let flushes = fake.calls.lock().flushes;
        fake.net.lock().network = vec![Ipv4Addr::new(192, 168, 1, 5)];
        advance(MIN).await;
        assert_eq!(fake.calls.lock().flushes, flushes);
        task.abort();
    }

    #[test]
    fn only_connections_through_a_server_are_closed() {
        let chain = |names: &[&str]| names.iter().map(|name| (*name).to_owned()).collect::<Vec<_>>();
        assert!(through_vpn(&chain(&["Sweden", "Auto", "Proxy"])));
        assert!(!through_vpn(&chain(&["DIRECT", "Games"])));
        assert!(!through_vpn(&chain(&["DIRECT"])));
        assert!(!through_vpn(&chain(&["REJECT", "Ads"])));
        assert!(!through_vpn(&[]));
    }

    #[tokio::test(start_paused = true)]
    async fn does_not_cut_connections_again_on_wake_or_network_events_while_the_server_stays_dead() {
        // The start check, a wake from sleep and every network change go through the same recovery.
        // After one full try (close everything, restart) a dead server is not fixed by more of
        // them, and each one cuts the game that goes past the VPN.
        let fake = Fake::new();
        fake.net.lock().vpn = false;
        let task = fake.spawn();
        advance(MIN).await;
        assert_eq!(fake.restarts(), 1);
        assert_eq!(fake.calls.lock().closes, 1);
        for i in 0..5u8 {
            fake.net.lock().network = vec![Ipv4Addr::new(10, 0, 0, i)];
            advance(MIN * 2).await;
        }
        assert_eq!(fake.restarts(), 1);
        assert_eq!(fake.calls.lock().closes, 1);
        task.abort();
    }

    #[tokio::test]
    async fn a_telegram_only_subscription_counts_as_working() {
        // The grace-period server passes Telegram and nothing else.
        let tried = Mutex::new(Vec::new());
        let works = any_passes(&VPN_URLS, |url| {
            tried.lock().push(url);
            async move { url.contains("telegram") }
        })
        .await;
        assert!(works);
        assert_eq!(*tried.lock(), VPN_URLS.to_vec());
    }

    #[tokio::test]
    async fn telegram_is_not_tried_while_the_main_check_passes() {
        let tried = Mutex::new(Vec::new());
        assert!(
            any_passes(&VPN_URLS, |url| {
                tried.lock().push(url);
                async { true }
            })
            .await
        );
        assert_eq!(*tried.lock(), vec![PROBE_URL]);
    }

    #[tokio::test]
    async fn nothing_passing_is_a_failure() {
        assert!(!any_passes(&VPN_URLS, |_| async { false }).await);
    }

    #[test]
    fn a_working_link_starts_a_new_stretch() {
        let mut planner = Planner::new();
        planner.vpn_silent_restarted = true;
        planner.fails = 3;
        assert_eq!(planner.report(LinkState::Ok), None);
        assert!(!planner.vpn_silent_restarted);
        assert_eq!(planner.fails, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn tries_one_restart_for_a_loop_then_says_another_vpn_interferes() {
        let fake = Fake::new();
        let task = fake.spawn();
        advance(Duration::from_secs(40)).await;
        // The core refuses its own traffic as a loop. Its own lost interface binding (after a
        // network change) is cured by a restart; another VPN's adapter is not, and then it says so.
        {
            let mut net = fake.net.lock();
            net.vpn = false;
            net.conflict = true;
        }
        advance(MIN * 30).await;
        assert_eq!(fake.state(), LinkState::Conflict);
        assert_eq!(fake.restarts(), 1);
        {
            let mut net = fake.net.lock();
            net.vpn = true;
            net.conflict = false;
        }
        advance(MIN * 2).await;
        assert_eq!(fake.state(), LinkState::Ok);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_loop_cured_by_the_restart_is_never_shown() {
        let fake = Fake::new();
        let task = fake.spawn();
        advance(Duration::from_secs(40)).await;
        {
            let mut net = fake.net.lock();
            net.vpn = false;
            net.conflict = true;
            net.restart_fixes_vpn = true;
            net.restart_clears_conflict = true;
        }
        advance(MIN * 5).await;
        assert_eq!(fake.restarts(), 1);
        assert!(!fake.calls.lock().published.contains(&LinkState::Conflict));
        assert_eq!(fake.state(), LinkState::Ok);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_wake_check_does_not_flash_ok_while_names_still_fail() {
        let fake = Fake::new();
        let task = fake.spawn();
        advance(Duration::from_secs(40)).await;
        fake.net.lock().system_dns = false;
        advance(MIN * 3).await;
        assert_eq!(fake.state(), LinkState::Conflict);
        let before = fake.calls.lock().published.len();
        // Another adapter appearing is a network change: the recovery check runs and its probe passes.
        fake.net.lock().network.push(Ipv4Addr::new(172, 19, 0, 1));
        advance(MIN * 2).await;
        let published = fake.calls.lock().published[before..].to_vec();
        assert!(!published.contains(&LinkState::Ok), "flashed {published:?}");
        assert_eq!(fake.state(), LinkState::Conflict);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn turning_the_vpn_off_and_on_starts_the_name_count_again() {
        let fake = Fake::new();
        let task = fake.spawn();
        advance(Duration::from_secs(40)).await;
        fake.net.lock().system_dns = false;
        advance(LINK_PROBE).await;
        fake.net.lock().connected = false;
        advance(LINK_PROBE).await;
        fake.net.lock().connected = true;
        advance(LINK_PROBE).await;
        // One failed lookup after reconnecting is not two in a row.
        assert!(!fake.calls.lock().published.contains(&LinkState::Conflict));
        task.abort();
    }

    #[test]
    fn a_few_loopback_rejects_in_the_recent_log_mean_a_conflict() {
        let line = |text: &str| text.to_owned();
        let mut logs: Vec<String> = (0..50).map(|i| line(&format!("info [TCP] ok {i}"))).collect();
        assert!(!loopback_conflict(&logs));
        logs.push(line(
            "warning [TCP] dial DIRECT 223.5.5.5:443 error: reject loopback connection to: 223.5.5.5:443",
        ));
        assert!(
            !loopback_conflict(&logs),
            "one line can be a stray loop of a single program"
        );
        for _ in 0..3 {
            logs.push(line(
                "warning [UDP] dial Proxy error: reject loopback connection to: 1.2.3.4:443",
            ));
        }
        assert!(loopback_conflict(&logs));
        // Old lines far behind the recent window do not count.
        logs.extend((0..LOG_WINDOW).map(|i| line(&format!("info [TCP] ok again {i}"))));
        assert!(!loopback_conflict(&logs));
    }

    #[tokio::test(start_paused = true)]
    async fn says_another_vpn_interferes_when_programs_cannot_resolve_names() {
        let fake = Fake::new();
        let task = fake.spawn();
        advance(Duration::from_secs(40)).await;
        // Happ's own TUN took the default route: the core still reaches its servers, but names
        // do not resolve for programs, so "Protected" would be a lie.
        fake.net.lock().system_dns = false;
        advance(MIN * 3).await;
        assert_eq!(fake.state(), LinkState::Conflict);
        assert_eq!(fake.restarts(), 0);
        fake.net.lock().system_dns = true;
        advance(MIN * 2).await;
        assert_eq!(fake.state(), LinkState::Ok);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn one_slow_name_lookup_is_not_a_conflict() {
        let fake = Fake::new();
        let task = fake.spawn();
        advance(Duration::from_secs(40)).await;
        fake.net.lock().system_dns = false;
        advance(LINK_PROBE).await;
        fake.net.lock().system_dns = true;
        advance(MIN * 3).await;
        assert!(!fake.calls.lock().published.contains(&LinkState::Conflict));
        task.abort();
    }
}
