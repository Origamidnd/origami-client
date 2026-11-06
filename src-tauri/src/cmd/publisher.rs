//! OrigamiVPN: who signed a program's file. Programs of one publisher go one way together, also a
//! game nobody has listed yet (src/origami/routes/publishers.ts).
use std::collections::HashMap;
use std::string::String as StdString;

#[cfg(any(windows, test))]
const MAX_PATHS: usize = 64;

/// Reads the paths as JSON from stdin, so that no path is ever part of the script. It holds no double
/// quote and fits one line, since it travels as one command line argument. It runs under any execution
/// policy, so it asks for none: antivirus programs watch for PowerShell started with a bypass.
#[cfg(any(windows, test))]
const SCRIPT: &str = "$utf8 = New-Object Text.UTF8Encoding $false; \
[Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8; \
$q = [char]34; $tab = [char]9; \
$pattern = '(?:^|, )O=(?:' + $q + '([^' + $q + ']+)' + $q + '|([^,]+))'; \
$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json; \
foreach ($path in $paths) { try { \
$signature = Get-AuthenticodeSignature -LiteralPath $path; \
if ($signature.Status -eq 'Valid') { \
$found = [regex]::Match($signature.SignerCertificate.Subject, $pattern); \
if ($found.Success) { [Console]::Out.WriteLine($path + $tab + $found.Groups[1].Value + $found.Groups[2].Value) } } \
} catch {} }";

/// `path<TAB>publisher` per line.
#[cfg(any(windows, test))]
fn parse_output(output: &str) -> HashMap<StdString, StdString> {
    output
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .map(|(path, publisher)| (path.trim().to_owned(), publisher.trim().to_owned()))
        .filter(|(path, publisher)| !path.is_empty() && !publisher.is_empty())
        .collect()
}

#[cfg(any(windows, test))]
fn usable_paths(mut paths: Vec<StdString>) -> Vec<StdString> {
    paths.retain(|path| {
        let mut chars = path.chars();
        chars.next().is_some_and(|c| c.is_ascii_alphabetic())
            && chars.next() == Some(':')
            && chars.next() == Some('\\')
            && !path.chars().any(char::is_control)
    });
    paths.truncate(MAX_PATHS);
    paths
}

#[cfg(windows)]
fn read_publishers(paths: &[StdString]) -> Option<HashMap<StdString, StdString>> {
    use std::io::Write as _;
    use std::os::windows::process::CommandExt as _;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let root = std::env::var_os("SystemRoot")?;
    let powershell = std::path::Path::new(&root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let mut child = Command::new(powershell)
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let input = serde_json::to_vec(paths).ok()?;
    child.stdin.take()?.write_all(&input).ok()?;
    let output = child.wait_with_output().ok()?;
    Some(parse_output(&StdString::from_utf8_lossy(&output.stdout)))
}

#[cfg(windows)]
async fn publishers_of(paths: Vec<StdString>) -> HashMap<StdString, StdString> {
    const DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);
    let paths = usable_paths(paths);
    if paths.is_empty() {
        return HashMap::new();
    }
    let work = tokio::task::spawn_blocking(move || read_publishers(&paths));
    match tokio::time::timeout(DEADLINE, work).await {
        Ok(Ok(Some(found))) => found,
        _ => HashMap::new(),
    }
}

#[cfg(not(windows))]
#[allow(
    clippy::unused_async,
    reason = "the same call as on Windows, where it waits for a process"
)]
async fn publishers_of(_paths: Vec<StdString>) -> HashMap<StdString, StdString> {
    HashMap::new()
}

/// Publisher by path, for the files with a valid signature. Without one a program has no publisher and
/// is linked by its folder alone, so any failure here only means that.
#[tauri::command]
#[specta::specta]
pub async fn origami_program_publishers(paths: Vec<StdString>) -> HashMap<StdString, StdString> {
    publishers_of(paths).await
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests assert by panicking")]
mod tests {
    use super::*;

    #[test]
    fn the_script_fits_one_argument_without_double_quotes() {
        assert!(!SCRIPT.contains('"'));
        assert!(!SCRIPT.contains('\n'));
    }

    #[test]
    fn reads_the_lines_of_the_script() {
        let found =
            parse_output("C:\\Games\\Игра\\a.exe\tBlizzard Entertainment, Inc.\r\nnoise\n\tno path\nC:\\b.exe\t\n");
        assert_eq!(found.len(), 1);
        assert_eq!(
            found.get("C:\\Games\\Игра\\a.exe").unwrap(),
            "Blizzard Entertainment, Inc."
        );
    }

    #[test]
    fn asks_only_about_windows_paths_and_not_too_many() {
        let paths = usable_paths(vec![
            "C:\\a.exe".into(),
            "/usr/bin/a".into(),
            "".into(),
            "C:\\a\nb.exe".into(),
            "relative\\a.exe".into(),
        ]);
        assert_eq!(paths, ["C:\\a.exe"]);
        assert_eq!(usable_paths(vec!["C:\\a.exe".into(); 100]).len(), MAX_PATHS);
    }
}
