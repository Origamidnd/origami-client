//! OrigamiVPN: closes the TUN before the core is stopped, on Windows.
//!
//! A core that exits with its TUN open (the app quits, an update installs, the core restarts) leaves
//! the wintun device behind as a phantom with the same GUID (it is derived from the adapter name). The
//! next core then waits ~15 s on it before mihomo retries and gets the adapter: no TUN, and no
//! internet in "whole computer" mode, for that long. A TUN the core closes itself leaves nothing
//! behind, and the next one comes up in about a second (Windows 10 22H2 VM, 23.11: 15.4 s against
//! 1.0 s). So the app asks the core to close it first and waits a moment for the adapter to go.

#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

use std::time::Duration;

use tokio::time::{self, Instant};

// The core may be the reason for the stop (hung): it gets this long to answer.
const API_DEADLINE: Duration = Duration::from_secs(3);
// The adapter went within a second in the VM.
const GONE_DEADLINE: Duration = Duration::from_secs(3);
const POLL: Duration = Duration::from_millis(200);

/// Polls until `gone` says so or the deadline passes. True when it went.
pub(crate) async fn wait_until_gone<F: FnMut() -> bool>(mut gone: F, deadline: Duration, poll: Duration) -> bool {
    let start = Instant::now();
    loop {
        if gone() {
            return true;
        }
        if start.elapsed() >= deadline {
            return false;
        }
        time::sleep(poll).await;
    }
}

#[cfg(target_os = "windows")]
fn adapter_present(name: &str) -> bool {
    use network_interface::{NetworkInterface, NetworkInterfaceConfig as _};
    NetworkInterface::show().is_ok_and(|list| list.iter().any(|interface| interface.name == name))
}

/// Before a core with an open TUN is stopped: turns its TUN off and waits for the adapter to go.
/// Does nothing when the core does not answer or has no TUN; the stop goes on either way.
#[cfg(target_os = "windows")]
pub async fn close_before_stop() {
    use clash_verge_logging::{Type, logging};

    let mihomo = crate::core::handle::Handle::mihomo();
    let Ok(Ok(config)) = time::timeout(API_DEADLINE, mihomo.get_base_config()).await else {
        return;
    };
    if !config.tun.enable {
        return;
    }
    let device = config.tun.device;
    let patch = serde_json::json!({ "tun": { "enable": false } });
    if !matches!(
        time::timeout(API_DEADLINE, mihomo.patch_base_config(&patch)).await,
        Ok(Ok(()))
    ) {
        logging!(
            info,
            Type::Core,
            "tun release: the core did not close its TUN, stopping it anyway"
        );
        return;
    }
    let started = Instant::now();
    let gone = wait_until_gone(|| !adapter_present(&device), GONE_DEADLINE, POLL).await;
    logging!(
        info,
        Type::Core,
        "tun release: closed the TUN before stopping the core; adapter {} in {} ms",
        if gone { "gone" } else { "still there" },
        started.elapsed().as_millis()
    );
}

#[cfg(not(target_os = "windows"))]
#[allow(clippy::unused_async)]
pub async fn close_before_stop() {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[tokio::test(start_paused = true)]
    async fn waits_for_the_adapter_to_go() {
        let looks = AtomicU32::new(0);
        let gone = wait_until_gone(|| looks.fetch_add(1, Ordering::Relaxed) >= 4, GONE_DEADLINE, POLL).await;
        assert!(gone);
        assert_eq!(looks.load(Ordering::Relaxed), 5);
    }

    #[tokio::test(start_paused = true)]
    async fn gives_up_so_the_stop_is_not_held_for_long() {
        let started = Instant::now();
        assert!(!wait_until_gone(|| false, GONE_DEADLINE, POLL).await);
        let waited = started.elapsed();
        assert!(
            waited >= GONE_DEADLINE && waited < GONE_DEADLINE + POLL * 2,
            "{waited:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn does_not_wait_when_there_is_nothing_to_wait_for() {
        let started = Instant::now();
        assert!(wait_until_gone(|| true, GONE_DEADLINE, POLL).await);
        assert_eq!(started.elapsed(), Duration::ZERO);
    }
}
