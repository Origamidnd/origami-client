//! OrigamiVPN: the support chat opens in the Telegram app when there is one, otherwise in the browser.
//! The link is built here from a checked address, so the web page never gets to open a `tg:` link.
use std::string::String as StdString;

fn is_name(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn is_invite(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// The same chat for the app; `None` for anything that is not a plain link to a Telegram chat.
fn telegram_app_link(url: &str) -> Option<StdString> {
    let rest = url
        .trim()
        .strip_prefix("https://")
        .or_else(|| url.trim().strip_prefix("http://"))?;
    let rest = rest.split(['?', '#']).next()?;
    let (host, path) = rest.split_once('/')?;
    if !matches!(
        host.to_ascii_lowercase().as_str(),
        "t.me" | "www.t.me" | "telegram.me" | "www.telegram.me"
    ) {
        return None;
    }
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    match parts.as_slice() {
        [invite] if invite.starts_with('+') => {
            let invite = &invite[1..];
            is_invite(invite).then(|| format!("tg://join?invite={invite}"))
        }
        ["joinchat", invite] => is_invite(invite).then(|| format!("tg://join?invite={invite}")),
        [name] => is_name(name).then(|| format!("tg://resolve?domain={name}")),
        _ => None,
    }
}

/// The program in a registered command, such as `"C:\Telegram\Telegram.exe" -- "%1"`.
#[cfg(any(windows, test))]
fn command_program(command: &str) -> Option<&str> {
    let command = command.trim();
    match command.strip_prefix('"') {
        Some(rest) => rest.split('"').next(),
        None => command.split_whitespace().next(),
    }
    .filter(|program| !program.is_empty())
}

#[cfg(windows)]
fn telegram_app_installed() -> bool {
    use std::path::Path;
    use winreg::{RegKey, enums::HKEY_CLASSES_ROOT};

    let classes = RegKey::predef(HKEY_CLASSES_ROOT);
    let registered = classes
        .open_subkey(r"tg\shell\open\command")
        .and_then(|key| key.get_value::<StdString, _>(""))
        .ok();
    // A removed portable copy leaves its command behind. An unexpanded path cannot be checked here.
    if let Some(program) = registered.as_deref().and_then(command_program)
        && (program.contains('%') || Path::new(program).exists())
    {
        return true;
    }
    // The Microsoft Store version registers the protocol with its package.
    classes
        .open_subkey(
            r"Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\PackageRepository\Extensions\windows.protocol\tg",
        )
        .is_ok()
}

#[cfg(target_os = "linux")]
fn telegram_app_installed() -> bool {
    std::process::Command::new("xdg-mime")
        .args(["query", "default", "x-scheme-handler/tg"])
        .output()
        .is_ok_and(|output| output.status.success() && !output.stdout.trim_ascii().is_empty())
}

#[cfg(not(any(windows, target_os = "linux")))]
const fn telegram_app_installed() -> bool {
    false
}

fn open_link(url: &str) -> Result<(), StdString> {
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|error| error.to_string())
}

/// Opens a support link; a link that is not a Telegram chat simply opens as it is.
#[tauri::command]
#[specta::specta]
pub async fn origami_open_support_chat(url: StdString) -> Result<(), StdString> {
    let lowered = url.trim().to_ascii_lowercase();
    if !lowered.starts_with("https://") && !lowered.starts_with("http://") {
        return Err("Only HTTP and HTTPS URLs are allowed".into());
    }
    let opened = tauri::async_runtime::spawn_blocking(move || {
        if let Some(link) = telegram_app_link(&url)
            && telegram_app_installed()
            && open_link(&link).is_ok()
        {
            return Ok(());
        }
        open_link(url.trim())
    })
    .await;
    opened.map_err(|error| error.to_string())?
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests assert by panicking")]
mod tests {
    use super::*;

    #[test]
    fn a_chat_link_becomes_an_app_link() {
        assert_eq!(
            telegram_app_link("https://t.me/Origami_Dragons").as_deref(),
            Some("tg://resolve?domain=Origami_Dragons")
        );
        assert_eq!(
            telegram_app_link(" http://telegram.me/Origami_Dragons/?x=1 ").as_deref(),
            Some("tg://resolve?domain=Origami_Dragons")
        );
    }

    #[test]
    fn an_invite_link_becomes_an_app_link() {
        assert_eq!(
            telegram_app_link("https://t.me/+AbC-d_1").as_deref(),
            Some("tg://join?invite=AbC-d_1")
        );
        assert_eq!(
            telegram_app_link("https://t.me/joinchat/AbC").as_deref(),
            Some("tg://join?invite=AbC")
        );
    }

    #[test]
    fn anything_else_stays_a_web_link() {
        for url in [
            "https://example.com/Origami_Dragons",
            "https://t.me.example.com/name",
            "https://t.me/",
            "https://t.me",
            "https://t.me/name&evil=1",
            "https://t.me/+bad&evil=1",
            "https://t.me/name/123",
            "tg://resolve?domain=name",
            "file:///C:/Windows/notepad.exe",
        ] {
            assert_eq!(telegram_app_link(url), None, "{url}");
        }
    }

    #[test]
    fn the_program_of_a_registered_command() {
        assert_eq!(
            command_program(r#""C:\Program Files\Telegram\Telegram.exe" -- "%1""#),
            Some(r"C:\Program Files\Telegram\Telegram.exe")
        );
        assert_eq!(command_program(r"C:\Telegram.exe %1"), Some(r"C:\Telegram.exe"));
        assert_eq!(command_program("  "), None);
    }
}
