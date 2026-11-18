#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod platform;
use std::{
    fs,
    io::Write,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

#[tauri::command]
fn app_language(app: tauri::AppHandle) -> &'static str {
    let language = app.path().app_data_dir().ok()
        .and_then(|data| fs::read_to_string(data.join("storage/settings.json")).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
    match language.as_ref().and_then(|settings| settings.get("language"))
        .and_then(serde_json::Value::as_str) {
        Some("es") => "es",
        Some("en") => "en",
        _ => platform::system_language(),
    }
}

fn text<'a>(app: &tauri::AppHandle, english: &'a str, spanish: &'a str) -> &'a str {
    if app_language(app.clone()) == "es" { spanish } else { english }
}
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_fs::FsExt;

const KEYS: [&str; 4] = [
    "ANTHROPIC_API_KEY",
    "FISH_AUDIO_API_KEY",
    "ELEVENLABS_API_KEY",
    "PIXABAY_API_KEY",
];

struct Server {
    child: Child,
    _group: platform::ProcessGroup,
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
struct Desktop {
    server: Mutex<Option<Server>>,
    origin: String,
    token: String,
    storage: PathBuf,
}

fn resources(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        if path.exists() {
            return Ok(path);
        }
    }
    app.path()
        .resource_dir()
        .map(|p| p.join("desktop"))
        .map_err(|e| e.to_string())
}
fn node(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "videogen-node-{}{}",
                env!("TAURI_ENV_TARGET_TRIPLE"),
                std::env::consts::EXE_SUFFIX
            )));
    }
    #[cfg(not(debug_assertions))]
    {
        Ok(_app
            .path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join(platform::node_filename()))
    }
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            return Err("Symbolic links are unsupported during import.".into());
        }
        let name = entry.file_name();
        if ["app.db", "app.db-wal", "app.db-shm"]
            .iter()
            .any(|s| name == *s)
        {
            continue;
        }
        let dest = target.join(name);
        if kind.is_dir() {
            copy_tree(&entry.path(), &dest)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn initialize_storage(
    app: &tauri::AppHandle,
    data: &Path,
    bundle: &Path,
    node: &Path,
) -> Result<PathBuf, String> {
    fs::create_dir_all(data).map_err(|e| e.to_string())?;
    let storage = data.join("storage");
    if storage.exists() {
        return Ok(storage);
    }
    let import = app.dialog().message(text(app, "Import a VideoGen storage folder? Choose Yes to select it or No to start without projects.", "¿Quieres importar la carpeta storage de VideoGen? Selecciona Sí para elegirla o No para empezar sin proyectos."))
        .title(text(app, "Welcome to VideoGen", "Bienvenido a VideoGen")).buttons(MessageDialogButtons::YesNo).blocking_show();
    if import {
        let picked = app
            .dialog()
            .file()
            .set_title(text(app, "Select the existing storage folder", "Selecciona la carpeta storage existente"))
            .blocking_pick_folder();
        if let Some(picked) = picked {
            let source = picked
                .into_path()
                .map_err(|_| text(app, "Invalid folder", "Carpeta no válida"))?
                .canonicalize()
                .map_err(|e| e.to_string())?;
            if !source.join("app.db").is_file() {
                return Err(text(app, "The selected folder does not contain app.db. Open VideoGen again to retry.", "La carpeta seleccionada no contiene app.db. Vuelve a abrir VideoGen para intentarlo otra vez.").into());
            }
            if source.starts_with(data) || data.starts_with(&source) {
                return Err(text(app, "Select the storage folder from the previous installation.", "Selecciona el almacenamiento de la aplicación anterior.").into());
            }
            let staging = data.join(format!("import-{}", uuid::Uuid::new_v4()));
            copy_tree(&source, &staging)?;
            let mut command = Command::new(node);
            command
                .arg(bundle.join("import.cjs"))
                .arg(source.join("app.db"))
                .arg(staging.join("app.db"));
            platform::hide_process(&mut command);
            if !command.status().map_err(|e| e.to_string())?.success() {
                return Err(text(app, "Could not import the database. The original files are intact.", "No se pudo importar la base de datos. El almacenamiento original sigue intacto.").into());
            }
            fs::rename(staging, &storage).map_err(|e| e.to_string())?;
        }
    }
    fs::create_dir_all(&storage).map_err(|e| e.to_string())?;
    Ok(storage)
}

fn start_server(app: &tauri::AppHandle) -> Result<Desktop, String> {
    let bundle = resources(app)?;
    let node = node(app)?;
    if !node.is_file() || !bundle.join("app/server.js").is_file() {
        return Err(text(app, "Packaged resources are missing. Run npm run desktop:prepare.", "Faltan los recursos empaquetados. Ejecuta npm run desktop:prepare.").into());
    }
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let storage = initialize_storage(app, &data, &bundle, &node)?;
    let models = storage.join("cache/hyperframes/whisper/models");
    fs::create_dir_all(&models).map_err(|e| e.to_string())?;
    let model = models.join("ggml-small.bin");
    if fs::metadata(&model).map(|m| m.len()).unwrap_or(0) != 487601967 {
        let pending = models.join("ggml-small.bin.part");
        fs::copy(bundle.join("model/ggml-small.bin"), &pending).map_err(|e| e.to_string())?;
        fs::rename(pending, &model).map_err(|e| e.to_string())?;
    }
    app.fs_scope()
        .allow_directory(&storage, true)
        .map_err(|e| e.to_string())?;
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    for _ in 0..3 {
        let socket = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = socket.local_addr().map_err(|e| e.to_string())?.port();
        let origin = format!("http://127.0.0.1:{port}");
        let mut command = Command::new(&node);
        command
            .arg(bundle.join("boot.cjs"))
            .current_dir(&data)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
        for key in KEYS {
            command.env_remove(key);
            if let Some(value) = platform::read_secret(key)? {
                command.env(key, value);
            }
        }
        command
            .env("NODE_ENV", "production")
            .env("HOSTNAME", "127.0.0.1")
            .env("PORT", port.to_string())
            .env("VIDEOGEN_DESKTOP", "1")
            .env("VIDEOGEN_APP_DIR", bundle.join("app"))
            .env("VIDEOGEN_NODE_PATH", &node)
            .env(
                "VIDEOGEN_HYPERFRAMES_CLI",
                bundle.join("runtime/node_modules/hyperframes/bin/hyperframes.mjs"),
            )
            .env("STORAGE_DIR", &storage)
            .env("VIDEOGEN_SYSTEM_LANGUAGE", platform::system_language())
            .env("VIDEOGEN_SESSION_TOKEN", &token)
            .env("VIDEOGEN_ORIGIN", &origin)
            .env(
                "FFMPEG_PATH",
                bundle
                    .join("tools")
                    .join(format!("ffmpeg{}", std::env::consts::EXE_SUFFIX)),
            )
            .env(
                "FFPROBE_PATH",
                bundle
                    .join("tools")
                    .join(format!("ffprobe{}", std::env::consts::EXE_SUFFIX)),
            )
            .env(
                "HYPERFRAMES_FFMPEG_PATH",
                bundle
                    .join("tools")
                    .join(format!("ffmpeg{}", std::env::consts::EXE_SUFFIX)),
            )
            .env(
                "HYPERFRAMES_FFPROBE_PATH",
                bundle
                    .join("tools")
                    .join(format!("ffprobe{}", std::env::consts::EXE_SUFFIX)),
            )
            .env(
                "HYPERFRAMES_BROWSER_PATH",
                bundle
                    .join("browser")
                    .join(platform::browser_relative_path()),
            )
            .env("HYPERFRAMES_NO_UPDATE_CHECK", "1")
            .env(
                "HYPERFRAMES_WHISPER_PATH",
                bundle.join("whisper").join(platform::whisper_filename()),
            )
            .env("HYPERFRAMES_CACHE_DIR", storage.join("cache/hyperframes"));
        platform::hide_process(&mut command);
        drop(socket);
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let group = match platform::ProcessGroup::attach(&child) {
            Ok(group) => group,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        };
        child
            .stdin
            .as_mut()
            .ok_or_else(|| text(app, "Could not start Node", "No se puede iniciar Node"))?
            .write_all(b"start\n")
            .map_err(|e| e.to_string())?;
        let mut server = Server {
            child,
            _group: group,
        };
        let deadline = Instant::now() + Duration::from_secs(90);
        while Instant::now() < deadline {
            if server
                .child
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_some()
            {
                break;
            }
            if ureq::get(format!("{origin}/api/desktop/health"))
                .config()
                .timeout_global(Some(Duration::from_secs(2)))
                .build()
                .header("x-videogen-session", &token)
                .call()
                .is_ok()
            {
                return Ok(Desktop {
                    server: Mutex::new(Some(server)),
                    origin,
                    token,
                    storage,
                });
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    Err(text(app, "Could not start the local server. Check the bundled resources and migrations.", "No se pudo iniciar el servidor local. Comprueba los recursos y las migraciones.").into())
}

fn open_main(app: &tauri::AppHandle, label: &str, path: &str) -> Result<(), String> {
    let state = app.state::<Desktop>();
    let mut url: tauri::Url = format!("{}/api/desktop/session", state.origin)
        .parse()
        .map_err(|_| text(app, "Invalid URL", "URL no válida"))?;
    url.query_pairs_mut()
        .append_pair("token", &state.token)
        .append_pair("next", path);
    let origin = state.origin.clone();
    let document_origin = origin.clone();
    let opener_app = app.clone();
    let init = "Object.defineProperty(window,'__VIDEOGEN_DESKTOP__',{value:true});document.addEventListener('DOMContentLoaded',()=>{document.documentElement.dataset.desktop='true';},{once:true});";
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("VideoGen")
        .inner_size(1440.0, 940.0)
        .min_inner_size(700.0, 480.0)
        .decorations(false)
        .transparent(true)
        .disable_drag_drop_handler()
        .initialization_script(init)
        .data_directory(
            app.path()
                .app_local_data_dir()
                .map_err(|e| e.to_string())?
                .join("webview"),
        )
        .on_navigation(move |url| url.origin().ascii_serialization() == origin)
        .on_new_window(move |url, features| {
            use tauri_plugin_opener::OpenerExt;
            if url.origin().ascii_serialization() == document_origin {
                let allowed_origin = document_origin.clone();
                let builder = WebviewWindowBuilder::new(
                    &opener_app,
                    format!("document-{}", uuid::Uuid::new_v4()),
                    WebviewUrl::External(url),
                )
                .window_features(features)
                .title("Documento · VideoGen")
                .inner_size(960.0, 720.0)
                .disable_drag_drop_handler()
                .on_navigation(move |target| {
                    target.origin().ascii_serialization() == allowed_origin
                });
                return match builder.build() {
                    Ok(window) => tauri::webview::NewWindowResponse::Create { window },
                    Err(_) => tauri::webview::NewWindowResponse::Deny,
                };
            }
            if matches!(url.scheme(), "https" | "http") {
                let _ = opener_app.opener().open_url(url.as_str(), None::<&str>);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
        .map_err(|e| e.to_string())?;
    platform::install_window_chrome(&window)?;
    let _ = platform::appearance(&window);
    Ok(())
}

#[tauri::command]
async fn open_project(app: tauri::AppHandle, id: String) -> Result<(), String> {
    uuid::Uuid::parse_str(&id).map_err(|_| text(&app, "Invalid project", "Proyecto no válido"))?;
    open_main(
        &app,
        &format!("project-{}", uuid::Uuid::new_v4()),
        &format!("/projects/{id}"),
    )
}
#[tauri::command]
async fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
        .title(text(&app, "VideoGen Settings", "Ajustes de VideoGen"))
        .inner_size(600.0, 680.0)
        .resizable(false)
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn credential_status(window: tauri::WebviewWindow) -> Result<Vec<bool>, String> {
    if window.label() != "settings" {
        return Err("Operation not allowed".into());
    }
    KEYS.iter()
        .map(|key| platform::read_secret(key).map(|v| v.is_some()))
        .collect()
}
#[tauri::command]
async fn import_credentials(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<usize, String> {
    if window.label() != "settings" {
        return Err("Operation not allowed".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .set_title(text(&app, "Import keys from .env.local", "Importar claves de .env.local"))
            .blocking_pick_file()
        else {
            return Ok(0);
        };
        let path = file.into_path().map_err(|_| "Invalid file")?;
        if fs::metadata(&path)
            .map_err(|_| "Could not read the file")?
            .len()
            > 65536
        {
            return Err("The configuration file is too large.".into());
        }
        let contents = fs::read_to_string(path).map_err(|_| "Could not read the file")?;
        let entries = dotenvy::from_read_iter(contents.as_bytes())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "The file is not a valid .env file")?;
        let mut count = 0;
        for (key, value) in entries {
            if KEYS.contains(&key.as_str()) && !value.trim().is_empty() {
                platform::write_secret(&key, &value)?;
                count += 1;
            }
        }
        Ok(count)
    })
    .await
    .map_err(|_| "Could not import the keys".to_string())?
}
#[tauri::command]
fn save_credential(window: tauri::WebviewWindow, key: String, value: String) -> Result<(), String> {
    if window.label() != "settings" || !KEYS.contains(&key.as_str()) || value.len() > 4000 {
        return Err("Invalid credential".into());
    }
    platform::write_secret(&key, value.trim())
}
#[tauri::command]
fn restart_app(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "settings" {
        return Err("Operation not allowed".into());
    }
    stop_server(&app);
    app.restart();
}
#[tauri::command]
fn resolve_video(app: tauri::AppHandle, relative: String) -> Result<String, String> {
    let state = app.state::<Desktop>();
    let root = state.storage.canonicalize().map_err(|e| e.to_string())?;
    let source = root
        .join(relative)
        .canonicalize()
        .map_err(|_| "The video does not exist")?;
    if !source.starts_with(root) || source.extension().and_then(|s| s.to_str()) != Some("mp4") {
        return Err("Invalid video".into());
    }
    Ok(source.to_string_lossy().into_owned())
}
#[tauri::command]
fn desktop_appearance(window: tauri::WebviewWindow) -> platform::Appearance {
    platform::appearance(&window)
}
#[tauri::command]
fn chrome_bounds(window: tauri::WebviewWindow, x: f64, y: f64, width: f64, height: f64) {
    platform::set_maximize_bounds(&window, x, y, width, height);
}

fn stop_server(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Desktop>() {
        if let Ok(mut server) = state.server.lock() {
            server.take();
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| { if let Some(window) = app.get_webview_window("main") { let _ = window.unminimize(); let _ = window.set_focus(); } }))
        .plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_fs::init()).plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![app_language, open_project, open_settings, credential_status, import_credentials, save_credential, restart_app, resolve_video, desktop_appearance, chrome_bounds])
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let result = (|| -> Result<(), String> {
                    let desktop = start_server(&handle)?;
                    let capability = serde_json::json!({ "identifier": "desktop-runtime", "windows": ["main", "project-*"], "local": false, "remote": {"urls": [format!("{}/*", desktop.origin)]}, "permissions": ["core:default", "core:window:allow-minimize", "core:window:allow-toggle-maximize", "core:window:allow-close", "core:window:allow-start-dragging", "dialog:allow-save", "fs:allow-copy-file", "opener:allow-open-url"] });
                    handle.add_capability(capability.to_string()).map_err(|e| e.to_string())?;
                    handle.manage(desktop);
                    open_main(&handle, "main", "/")?;
                    if let Some(splash) = handle.get_webview_window("splash") { let _ = splash.close(); }
                    Ok(())
                })();
                if let Err(error) = result {
                    stop_server(&handle);
                    handle.dialog().message(error).title("VideoGen no pudo arrancar").blocking_show();
                    handle.exit(1);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!()).expect("Could not create VideoGen")
        .run(|app, event| {
            match event {
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. } => stop_server(app),
                tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } if label == "main" => { stop_server(app); app.exit(0); },
                tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::ThemeChanged(_), .. } => {
                    if let Some(window) = app.get_webview_window(&label) { let _ = window.emit("desktop-appearance", platform::appearance(&window)); }
                }
                _ => {}
            }
        });
}
