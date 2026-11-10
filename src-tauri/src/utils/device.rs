//! Device identity sent with subscription requests, so the panel counts each computer once
//! and shows it by name in the user's device list.

use sha2::{Digest as _, Sha256};
use std::sync::OnceLock;

/// Salt keeps the HWID specific to OrigamiVPN instead of exposing the raw machine id.
const HWID_SALT: &str = "origamivpn-hwid-v1";
const MODEL_MAX_CHARS: usize = 64;

pub struct DeviceInfo {
    pub hwid: String,
    pub os: &'static str,
    pub os_version: String,
    pub model: String,
}

static DEVICE: OnceLock<DeviceInfo> = OnceLock::new();

pub fn device_info() -> &'static DeviceInfo {
    DEVICE.get_or_init(|| DeviceInfo {
        hwid: hwid_from(&machine_id()),
        os: os_name(),
        os_version: ascii_or(sysinfo::System::os_version(), "unknown"),
        model: model_name(),
    })
}

/// The only host that gets the device headers: our own subscription server, over https.
const SUBSCRIPTION_HOST: &str = "sub.origamivpn.pro";

/// Device identity is for our panel's device list; another subscription server, or a host
/// ours redirects to, must not learn the HWID or the computer name.
pub fn is_subscription_host(url: &tauri::Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some(SUBSCRIPTION_HOST)
}

/// Headers understood by Remnawave: x-hwid, x-device-os, x-ver-os, x-device-model.
pub fn device_headers() -> [(&'static str, String); 4] {
    let info = device_info();
    [
        ("x-hwid", info.hwid.clone()),
        ("x-device-os", info.os.to_owned()),
        ("x-ver-os", info.os_version.clone()),
        ("x-device-model", info.model.clone()),
    ]
}

fn hwid_from(machine_id: &str) -> String {
    let digest = Sha256::digest(format!("{HWID_SALT}:{machine_id}").as_bytes());
    digest.iter().take(16).map(|byte| format!("{byte:02x}")).collect()
}

const fn os_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "Windows"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else {
        "Linux"
    }
}

/// Computer name when it is plain ASCII (HTTP headers carry it as is), otherwise a generic label.
fn model_name() -> String {
    let host = gethostname::gethostname().to_string_lossy().trim().to_owned();
    let fallback = format!("{} PC", os_name());
    let model = ascii_or(Some(host), &fallback);
    model.chars().take(MODEL_MAX_CHARS).collect()
}

fn ascii_or(value: Option<String>, fallback: &str) -> String {
    match value {
        Some(text) if !text.is_empty() && text.bytes().all(|b| b.is_ascii_graphic() || b == b' ') => text,
        _ => fallback.to_owned(),
    }
}

#[cfg(target_os = "windows")]
fn platform_machine_id() -> Option<String> {
    use winreg::{RegKey, enums::HKEY_LOCAL_MACHINE};

    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\Microsoft\\Cryptography")
        .ok()?;
    key.get_value::<String, _>("MachineGuid").ok()
}

#[cfg(target_os = "linux")]
fn platform_machine_id() -> Option<String> {
    ["/etc/machine-id", "/var/lib/dbus/machine-id"]
        .iter()
        .find_map(|path| std::fs::read_to_string(path).ok())
}

#[cfg(target_os = "macos")]
fn platform_machine_id() -> Option<String> {
    let output = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    let text = std::string::String::from_utf8_lossy(&output.stdout);
    let line = text.lines().find(|line| line.contains("IOPlatformUUID"))?;
    line.split('"').nth(3).map(str::to_owned)
}

/// Machine id from the OS; falls back to an id stored next to the app config.
fn machine_id() -> String {
    if let Some(id) = platform_machine_id().map(|id| id.trim().to_owned())
        && !id.is_empty()
    {
        return id;
    }
    stored_machine_id()
}

fn stored_machine_id() -> String {
    let path = crate::utils::dirs::app_home_dir().map(|dir| dir.join("device-id"));
    if let Ok(path) = &path
        && let Ok(id) = std::fs::read_to_string(path)
        && !id.trim().is_empty()
    {
        return id.trim().to_owned();
    }
    let id = nanoid::nanoid!(32);
    if let Ok(path) = &path {
        let _ = std::fs::write(path, &id);
    }
    id
}

#[cfg(test)]
#[allow(clippy::expect_used, reason = "tests assert by panicking")]
mod tests {
    use super::{ascii_or, hwid_from, is_subscription_host};

    #[test]
    fn hwid_is_stable_hex_and_hides_machine_id() {
        let first = hwid_from("machine-123");
        assert_eq!(first, hwid_from("machine-123"));
        assert_eq!(first.len(), 32);
        assert!(first.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(first, hwid_from("machine-124"));
        assert!(!first.contains("machine"));
    }

    #[test]
    fn non_ascii_names_fall_back() {
        assert_eq!(ascii_or(Some("DESKTOP-42".into()), "PC"), "DESKTOP-42");
        assert_eq!(
            ascii_or(Some("\u{418}\u{432}\u{430}\u{43d}-\u{41f}\u{41a}".into()), "PC"),
            "PC"
        );
        assert_eq!(ascii_or(None, "PC"), "PC");
    }

    #[test]
    fn only_our_https_subscription_host_gets_device_headers() {
        let host = |u: &str| is_subscription_host(&tauri::Url::parse(u).expect("url"));
        assert!(host("https://sub.origamivpn.pro/AbCdEf1234567890"));
        assert!(host("https://sub.origamivpn.pro:2096/AbCdEf1234567890"));
        assert!(!host("http://sub.origamivpn.pro/AbCdEf1234567890"));
        assert!(!host("https://sub.origamivpn.pro.example.com/AbCdEf1234567890"));
        assert!(!host("https://lk.origamivpn.pro/AbCdEf1234567890"));
        assert!(!host("https://example.com/sub/AbCdEf1234567890"));
    }
}
