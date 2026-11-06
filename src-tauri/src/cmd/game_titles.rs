//! OrigamiVPN: the name of a game behind a program file, for the Programs tab. Only a label: nothing
//! here decides how a program goes. The list comes from our server and is kept on disk, so without it
//! a program simply shows its file name.
use crate::utils::{
    dirs,
    network::{NetworkManager, ProxyType},
};
use parking_lot::RwLock;
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    string::String as StdString,
    sync::{
        Arc, LazyLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const LIST_URL: &str = "https://sub.origamivpn.pro/geo/games-apps.json";
const CACHE_FILE: &str = "games-apps.json";
const MAX_BYTES: usize = 8 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_SECS: u64 = 30;
const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
// A server that does not answer is not asked again at every look at the tab.
const RETRY_AFTER_SECS: u64 = 60 * 60;

#[derive(Deserialize)]
struct RawGame {
    title: StdString,
    exes: Vec<StdString>,
    /// Names that many programs use, such as `javaw.exe`: on their own they say nothing.
    #[serde(default)]
    generic: Vec<StdString>,
}

struct Entry {
    /// The file with the folders above it, such as `_retail_/wow.exe`; empty for a bare file name.
    suffix: StdString,
    title: usize,
}

#[derive(Default)]
struct GameIndex {
    titles: Vec<StdString>,
    by_file: HashMap<StdString, Vec<Entry>>,
}

impl GameIndex {
    fn parse(body: &[u8]) -> Option<Self> {
        let games: Vec<RawGame> = serde_json::from_slice(body).ok()?;
        if games.is_empty() {
            return None;
        }
        let mut index = Self::default();
        for game in games {
            let title = index.titles.len();
            let generic: HashSet<StdString> = game.generic.iter().map(|name| name.to_lowercase()).collect();
            for exe in &game.exes {
                let exe = exe.replace('\\', "/").to_lowercase();
                let (folders, file) = exe.rsplit_once('/').unwrap_or(("", exe.as_str()));
                if file.is_empty() || (folders.is_empty() && generic.contains(file)) {
                    continue;
                }
                let suffix = if folders.is_empty() { "" } else { exe.as_str() };
                index.by_file.entry(file.to_owned()).or_default().push(Entry {
                    suffix: suffix.to_owned(),
                    title,
                });
            }
            index.titles.push(game.title);
        }
        Some(index)
    }

    /// `path` is a full path, or the bare name when the core could not tell the path.
    fn title_of(&self, path: &str) -> Option<&str> {
        let path = path.replace('\\', "/").to_lowercase();
        let file = path.rsplit('/').next()?;
        let entries = self.by_file.get(file)?;
        let with_folders = entries
            .iter()
            .filter(|entry| {
                !entry.suffix.is_empty()
                    && path
                        .strip_suffix(entry.suffix.as_str())
                        .is_some_and(|rest| rest.is_empty() || rest.ends_with('/'))
            })
            .max_by_key(|entry| entry.suffix.len());
        if let Some(entry) = with_folders {
            return self.titles.get(entry.title).map(StdString::as_str);
        }
        // A bare name counts only when a single game claims it: `game.exe` belongs to nobody.
        let mut bare = entries
            .iter()
            .filter(|entry| entry.suffix.is_empty())
            .map(|entry| entry.title);
        let title = bare.next()?;
        bare.all(|other| other == title)
            .then(|| self.titles.get(title).map(StdString::as_str))
            .flatten()
    }
}

static INDEX: LazyLock<RwLock<Option<Arc<GameIndex>>>> = LazyLock::new(|| RwLock::new(None));
static LAST_DOWNLOAD: AtomicU64 = AtomicU64::new(0);

fn cache_path() -> Option<PathBuf> {
    dirs::app_home_dir().ok().map(|home| home.join(CACHE_FILE))
}

fn is_stale(path: &Path) -> bool {
    let age = std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok());
    age.is_none_or(|age| age >= MAX_AGE)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

/// Takes the list from the server; a broken answer leaves what is on disk as it is.
async fn download(path: PathBuf) {
    let body = NetworkManager::new()
        .get_bytes(LIST_URL, ProxyType::None, Some(DOWNLOAD_TIMEOUT_SECS), MAX_BYTES)
        .await;
    let Ok(body) = body else { return };
    let Some(index) = GameIndex::parse(&body) else { return };
    let temporary = path.with_extension("json.tmp");
    let saved = tokio::fs::write(&temporary, &body).await.is_ok() && tokio::fs::rename(&temporary, &path).await.is_ok();
    if !saved {
        drop(tokio::fs::remove_file(&temporary).await);
    }
    *INDEX.write() = Some(Arc::new(index));
}

async fn load_index() -> Option<Arc<GameIndex>> {
    let loaded = INDEX.read().clone();
    if loaded.is_some() {
        return loaded;
    }
    let body = tokio::fs::read(cache_path()?).await.ok()?;
    let index = Arc::new(GameIndex::parse(&body)?);
    *INDEX.write() = Some(Arc::clone(&index));
    Some(index)
}

/// Titles by the given path, for the programs known to be games. The first look without a list waits
/// for the download; after that an old list is renewed in the background.
#[tauri::command]
#[specta::specta]
pub async fn origami_game_titles(paths: Vec<StdString>) -> HashMap<StdString, StdString> {
    let mut index = load_index().await;
    if let Some(path) = cache_path()
        && is_stale(&path)
    {
        let now = now_secs();
        let last = LAST_DOWNLOAD.load(Ordering::Relaxed);
        if now.saturating_sub(last) >= RETRY_AFTER_SECS {
            LAST_DOWNLOAD.store(now, Ordering::Relaxed);
            if index.is_some() {
                tokio::spawn(download(path));
            } else {
                download(path).await;
                index = load_index().await;
            }
        }
    }
    let Some(index) = index else {
        return HashMap::new();
    };
    paths
        .into_iter()
        .filter_map(|path| {
            let title = index.title_of(&path)?.to_owned();
            Some((path, title))
        })
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests assert by panicking")]
mod tests {
    use super::*;

    fn index() -> GameIndex {
        GameIndex::parse(
            br#"[
              {"id":"1","title":"World of Warcraft","exes":["_retail_/wow.exe","_ptr_/wow.exe"]},
              {"id":"2","title":"Dota 2","exes":["dota2.exe"]},
              {"id":"3","title":"Minecraft","exes":["minecraft/runtime/bin/javaw.exe","javaw.exe"],"generic":["javaw.exe"]},
              {"id":"4","title":"One","exes":["game.exe"]},
              {"id":"5","title":"Two","exes":["game.exe","two/game.exe"]}
            ]"#,
        )
        .unwrap()
    }

    #[test]
    fn a_name_with_folders_needs_those_folders() {
        let index = index();
        assert_eq!(
            index.title_of(r"C:\Program Files (x86)\World of Warcraft\_retail_\Wow.exe"),
            Some("World of Warcraft")
        );
        assert_eq!(index.title_of(r"C:\Other\Wow.exe"), None);
        assert_eq!(index.title_of(r"C:\not_retail_\Wow.exe"), None);
    }

    #[test]
    fn a_bare_name_counts_whatever_the_case_and_folder() {
        let index = index();
        assert_eq!(
            index.title_of(r"D:\Steam\steamapps\common\dota 2\DOTA2.EXE"),
            Some("Dota 2")
        );
        assert_eq!(index.title_of("dota2.exe"), Some("Dota 2"));
    }

    #[test]
    fn a_generic_name_counts_only_with_its_folders() {
        let index = index();
        assert_eq!(index.title_of(r"C:\Java\bin\javaw.exe"), None);
        assert_eq!(
            index.title_of(r"C:\Games\minecraft\runtime\bin\javaw.exe"),
            Some("Minecraft")
        );
    }

    #[test]
    fn a_name_of_several_games_belongs_to_none_without_folders() {
        let index = index();
        assert_eq!(index.title_of(r"C:\Games\game.exe"), None);
        assert_eq!(index.title_of(r"C:\Games\two\game.exe"), Some("Two"));
    }

    #[test]
    fn a_broken_list_is_not_taken() {
        assert!(GameIndex::parse(b"<html>not found</html>").is_none());
        assert!(GameIndex::parse(b"[]").is_none());
        assert!(GameIndex::parse(br#"[{"id":"1"}]"#).is_none());
    }

    #[test]
    fn the_published_format_parses() {
        let body = br#"[{"id":"1","title":"A","exes":["a.exe"],"extra":1}]"#;
        assert_eq!(GameIndex::parse(body).unwrap().title_of("a.exe"), Some("A"));
    }
}
