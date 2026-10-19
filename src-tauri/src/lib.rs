mod omr;
mod package;
mod sources;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Manager, State};

/// Each open project gets a scratch folder in app data holding its source images.
/// The `.beatmark` package is assembled from it on save and unpacked into a fresh one on open.
struct AppState {
    data_dir: PathBuf,
    workspace: Mutex<PathBuf>,
}

impl AppState {
    fn sources_dir(&self) -> PathBuf {
        self.workspace.lock().unwrap().join(package::SOURCES_DIR)
    }

    fn fresh_workspace(&self) -> Result<PathBuf, String> {
        let dir = self.data_dir.join("workspaces").join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(dir.join(package::SOURCES_DIR)).map_err(|e| e.to_string())?;
        Ok(dir)
    }

    fn recovery_dir(&self) -> PathBuf {
        self.data_dir.join("recovery")
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryMeta {
    workspace: PathBuf,
    file_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Recovered {
    project_json: String,
    file_path: Option<String>,
}

type CmdResult<T> = Result<T, String>;

#[tauri::command]
fn new_project(state: State<AppState>) -> CmdResult<()> {
    let dir = state.fresh_workspace()?;
    *state.workspace.lock().unwrap() = dir;
    Ok(())
}

#[tauri::command]
fn open_project(state: State<AppState>, path: String) -> CmdResult<String> {
    let dir = state.fresh_workspace()?;
    let json = package::read_package(Path::new(&path), &dir.join(package::SOURCES_DIR))?;
    *state.workspace.lock().unwrap() = dir;
    Ok(json)
}

#[tauri::command]
fn save_project(state: State<AppState>, path: String, project_json: String) -> CmdResult<()> {
    package::write_package(Path::new(&path), &project_json, &state.sources_dir())
}

#[tauri::command]
fn import_image(state: State<AppState>, path: String) -> CmdResult<sources::ImportedSource> {
    sources::import_image(Path::new(&path), &state.sources_dir())
}

/// Raw PNG body (e.g. a PDF page rendered in the UI); the original name comes in a header.
#[tauri::command]
fn import_png(state: State<AppState>, request: Request) -> CmdResult<sources::ImportedSource> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw PNG bytes".into());
    };
    let name = request
        .headers()
        .get("x-original-name")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("page.png");
    sources::import_png_bytes(bytes, name, &state.sources_dir())
}

#[tauri::command]
fn read_source(state: State<AppState>, file_name: String) -> CmdResult<Response> {
    if !package::is_safe_name(&file_name) {
        return Err("Invalid source name".into());
    }
    let bytes = fs::read(state.sources_dir().join(&file_name)).map_err(|_| format!("Source image {file_name} is missing"))?;
    Ok(Response::new(bytes))
}

#[tauri::command]
fn recognize_source(state: State<AppState>, file_name: String) -> CmdResult<omr::Recognition> {
    if !package::is_safe_name(&file_name) {
        return Err("Invalid source name".into());
    }
    omr::recognize(&state.sources_dir().join(file_name))
}

/// For exports (MusicXML); `path` comes from the user's save dialog.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> CmdResult<()> {
    write_atomic(Path::new(&path), contents.as_bytes())
}

#[tauri::command]
fn autosave(state: State<AppState>, project_json: String, file_path: Option<String>) -> CmdResult<()> {
    let dir = state.recovery_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let meta = RecoveryMeta { workspace: state.workspace.lock().unwrap().clone(), file_path };
    write_atomic(&dir.join("project.json"), project_json.as_bytes())?;
    write_atomic(&dir.join("meta.json"), serde_json::to_string(&meta).unwrap().as_bytes())
}

/// Returns the autosaved draft from a session that didn't close cleanly, and switches to its workspace.
#[tauri::command]
fn take_recovery(state: State<AppState>) -> CmdResult<Option<Recovered>> {
    let dir = state.recovery_dir();
    let (Ok(project_json), Ok(meta)) = (fs::read_to_string(dir.join("project.json")), fs::read_to_string(dir.join("meta.json"))) else {
        return Ok(None);
    };
    let meta: RecoveryMeta = serde_json::from_str(&meta).map_err(|e| e.to_string())?;
    if meta.workspace.is_dir() {
        *state.workspace.lock().unwrap() = meta.workspace;
    }
    Ok(Some(Recovered { project_json, file_path: meta.file_path }))
}

/// Called after a successful save, a declined recovery, or a clean quit.
#[tauri::command]
fn clear_recovery(state: State<AppState>) -> CmdResult<()> {
    let dir = state.recovery_dir();
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> CmdResult<()> {
    // A unique sibling name, so we never clobber a user's own "*.tmp" file.
    let tmp = path.with_file_name(format!(".{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Removes workspaces from earlier sessions, except one an autosave still points to.
fn prune_workspaces(data_dir: &Path, keep: &Path) {
    let keep_recovery = fs::read_to_string(data_dir.join("recovery").join("meta.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<RecoveryMeta>(&s).ok())
        .map(|m| m.workspace);
    let Ok(entries) = fs::read_dir(data_dir.join("workspaces")) else { return };
    for entry in entries.flatten() {
        let p = entry.path();
        if p != keep && Some(&p) != keep_recovery.as_ref() {
            let _ = fs::remove_dir_all(p);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let state = AppState { data_dir: data_dir.clone(), workspace: Mutex::new(PathBuf::new()) };
            let ws = state.fresh_workspace()?;
            prune_workspaces(&data_dir, &ws);
            *state.workspace.lock().unwrap() = ws;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            new_project,
            open_project,
            save_project,
            import_image,
            import_png,
            read_source,
            recognize_source,
            write_text_file,
            autosave,
            take_recovery,
            clear_recovery,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
