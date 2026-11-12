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
// One check a little after start: a core left over from an install over a running app can be up
// but pass no traffic until it is restarted.
const STARTUP_CHECK: Duration = Duration::from_secs(30);
// While the VPN is on the link is probed all the time; a failed probe is repeated soon, and only
// the second failure in a row changes what the app says.
const LINK_PROBE: Duration = Duration::from_secs(30);
const LINK_CONFIRM: Duration = Duration::from_secs(10);
const LINK_FAILS: u32 = 2;
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
}

impl LinkState {
    const fn to_u8(self) -> u8 {
        match self {
            Self::Ok => 0,
            Self::NoInternet => 1,
            Self::Down => 2,
        }
    }

    const fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::NoInternet,
            2 => Self::Down,
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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    Ok,
    Restarted,
    NoInternet,
    Failed,
}

impl Outcome {
    const fn state(self) -> LinkState {
        match self {
            Self::Ok | Self::Restarted => LinkState::Ok,
            Self::NoInternet => LinkState::NoInternet,
            Self::Failed => LinkState::Down,
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
    fn diagnose(&self) -> impl Future<Output = Verdict> + Send;
    fn flush_dns(&self) -> impl Future<Output = ()> + Send;
    fn close_connections(&self) -> impl Future<Output = ()> + Send;
    fn restart_core(&self) -> impl Future<Output = ()> + Send;
    fn publish(&self, state: LinkState) -> impl Future<Output = ()> + Send;
    fn notice(&self, key: &'static str);
    fn wall(&self) -> SystemTime;
    /// The computer's own IPv4 addresses, without the VPN adapter, sorted.
    fn network(&self) -> Vec<Ipv4Addr>;
}

/// After a wake from sleep or a network change, DNS answers and old connections may point at the
/// previous network. This drops the DNS cache, and if the link through the core does not work and
/// the internet is there, closes the stale connections, checks again and restarts the core once.
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
    if verdict == Verdict::VpnSilent && !force && !vpn_silent_retry {
        return Outcome::Failed;
    }
    if verdict != Verdict::CoreSilent {
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
    if env.diagnose().await == Verdict::NoInternet {
        Outcome::NoInternet
    } else {
        Outcome::Failed
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
    fn report(&mut self, state: LinkState) -> Option<LinkState> {
        if state == LinkState::Ok {
            self.fails = 0;
            self.hang_retry = HANG_RETRY;
            self.next_hang_run = None;
            self.no_internet_since = None;
            self.vpn_silent_since = None;
            self.vpn_silent_restarted = false;
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

    fn after_run(&mut self, outcome: Outcome) -> LinkState {
        // A full try that did not help: wake, network and start checks leave this stretch alone.
        if outcome == Outcome::Failed {
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
        // Like the browser's "online": a network that appeared or changed, not one that went away.
        let network = self.env.network();
        let changed = !network.is_empty() && network != self.network;
        self.network = network;
        if slept || changed {
            self.pending = Some(self.planner.schedule(Reason::Network, false, Instant::now()));
        }
    }

    async fn check_link(&mut self) {
        self.confirm = None;
        if !self.env.connected().await {
            self.report(LinkState::Ok).await;
            return;
        }
        if self.env.probe().await {
            self.report(LinkState::Ok).await;
            return;
        }
        if !self.planner.failed_probe() {
            self.confirm = Some(Instant::now() + LINK_CONFIRM);
            return;
        }
        let verdict = self.env.diagnose().await;
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
        self.report(state).await;
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
        pending: None,
        confirm: None,
        last_wall,
        network,
    }
    .run()
    .await;
}

/// Started once the core is up.
pub fn start() {
    crate::process::AsyncHandler::spawn(|| watch(real::CoreEnv));
}

mod real {
    use super::{
        API_DEADLINE, DIRECT_URLS, Env, FAILED_DELAY_MS, LinkState, Ordering, PROBE_DEADLINE, PROBE_TIMEOUT_MS, STATE,
        VPN_URLS, Verdict, any_passes,
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

        async fn diagnose(&self) -> Verdict {
            if !matches!(
                time::timeout(API_DEADLINE, Handle::mihomo().get_version()).await,
                Ok(Ok(_))
            ) {
                return Verdict::CoreSilent;
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
            let _ = time::timeout(API_DEADLINE, Handle::mihomo().close_all_connections()).await;
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
        connected: bool,
        // A restart brings these back.
        restart_fixes_vpn: bool,
        restart_fixes_core: bool,
        wall_offset: Duration,
        network: Vec<Ipv4Addr>,
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
                    connected: true,
                    restart_fixes_vpn: false,
                    restart_fixes_core: false,
                    wall_offset: Duration::ZERO,
                    network: vec![Ipv4Addr::new(192, 168, 1, 5)],
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
            let net = self.net.lock();
            net.core && net.vpn && net.internet
        }

        async fn diagnose(&self) -> Verdict {
            let net = self.net.lock();
            if !net.core {
                Verdict::CoreSilent
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
    async fn checks_once_about_half_a_minute_after_start_and_restarts_a_silent_vpn() {
        let fake = Fake::new();
        {
            let mut net = fake.net.lock();
            net.vpn = false;
            net.restart_fixes_vpn = true;
        }
        let task = fake.spawn();
        advance(Duration::from_secs(20)).await;
        assert_eq!(fake.calls.lock().probes, 0);
        advance(Duration::from_secs(40)).await;
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
        advance(Duration::from_secs(25)).await;
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
}
