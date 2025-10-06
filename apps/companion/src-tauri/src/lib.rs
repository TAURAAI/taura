use bytes::Bytes;
use futures_util::stream;
use once_cell::sync::Lazy;
use std::collections::HashSet;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use tokio::time::sleep; // for throttled scan yielding

mod oauth;
use oauth::{get_session, google_auth_start, logout, refresh_session, ensure_fresh_session};

// Cancellation + config state
static CANCEL_SCAN: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));
static DEFAULT_THROTTLE_VALUE: Lazy<std::sync::Mutex<u64>> =
    Lazy::new(|| std::sync::Mutex::new(40)); // 40ms gentle by default
use std::process::Command;
use walkdir::WalkDir;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[derive(serde::Serialize)]
struct MediaMeta {
    path: String,
    size: u64,
    modified: Option<String>,
    modality: String,
    lat: Option<f64>,
    lon: Option<f64>,
    timestamp: Option<String>,
}

#[derive(serde::Serialize)]
struct ScanResult {
    count: usize,
    samples: Vec<String>,
    items: Vec<MediaMeta>,
}

fn is_media_file(entry: &std::path::Path) -> bool {
    match entry
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
    {
        Some(ext) => matches!(
            ext.as_str(),
            "jpg"
                | "jpeg"
                | "png"
                | "gif"
                | "webp"
                | "bmp"
                | "tiff"
                | "tif"
                | "heic"
                | "heif"
                | "pdf"
                | "mp4"
                | "mov"
                | "avi"
                | "mkv"
        ),
        None => false,
    }
}

#[tauri::command]
async fn get_default_folder() -> Result<String, String> {
    let home_dir = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| "C:\\".to_string());
    let pictures_path = format!("{}\\Pictures", home_dir);

    if std::path::Path::new(&pictures_path).exists() {
        Ok(pictures_path)
    } else {
        Ok(home_dir)
    }
}

#[tauri::command]
async fn pick_folder() -> Result<Option<String>, String> {
    // Use rfd to show a native folder picker dialog
    let folder = rfd::FileDialog::new()
        .set_title("Select Media Folder")
        .pick_folder();

    match folder {
        Some(path) => Ok(Some(path.to_string_lossy().to_string())),
        None => Ok(None),
    }
}

#[tauri::command]
async fn scan_folder(
    path: String,
    max_samples: Option<usize>,
    throttle_ms: Option<u64>,
    app: tauri::AppHandle,
) -> Result<ScanResult, String> {
    if path.is_empty() {
        return Err("path empty".into());
    }
    // Reset cancellation flag at start
    CANCEL_SCAN.store(false, Ordering::SeqCst);
    let limit = max_samples.unwrap_or(10);
    let mut samples = Vec::new();
    let mut count: usize = 0;
    let mut items: Vec<MediaMeta> = Vec::new();

    let walker = WalkDir::new(&path).follow_links(false).max_depth(8);
    let mut processed: usize = 0;
    let mut last_emit = std::time::Instant::now();

    // initial event (indeterminate total)
    let _ = app.emit(
        "scan_progress",
        serde_json::json!({
          "path": path,
          "processed": 0,
          "total": 0,
          "matched": 0
        }),
    );

    let sleep_every = 32usize; // after how many files to apply sleep
    let throttle = throttle_ms
        .or_else(|| {
            // use stored default throttle if user didn't explicitly pass one
            Some(*DEFAULT_THROTTLE_VALUE.lock().unwrap())
        })
        .unwrap_or(0);
    for entry in walker {
        if CANCEL_SCAN.load(Ordering::SeqCst) {
            let _ = app.emit(
                "scan_progress",
                serde_json::json!({
                  "path": path,
                  "processed": processed,
                  "total": processed,
                  "matched": count,
                  "cancelled": true,
                  "done": true
                }),
            );
            return Ok(ScanResult {
                count,
                samples,
                items,
            });
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.file_type().is_file() {
            processed += 1;
            let p = entry.path();
            if is_media_file(p) {
                count += 1;
                if samples.len() < limit {
                    if let Some(s) = p.to_str() {
                        samples.push(s.to_string());
                    }
                }
                let mut size: u64 = 0;
                let mut modified: Option<String> = None;
                if let Ok(md) = entry.metadata() {
                    size = md.len();
                    if let Ok(mt) = md.modified() {
                        let dt: chrono::DateTime<chrono::Utc> = mt.into();
                        modified = Some(dt.to_rfc3339());
                    }
                }
                let (lat, lon, exif_timestamp) = (None, None, None);
                let modality = match p
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_lowercase())
                {
                    Some(ext) if ext == "pdf" => "pdf_page".to_string(),
                    Some(ext) if matches!(ext.as_str(), "mp4" | "mov" | "avi" | "mkv") => {
                        "video".to_string()
                    }
                    _ => "image".to_string(),
                };
                if let Some(s) = p.to_str() {
                    items.push(MediaMeta {
                        path: s.to_string(),
                        size,
                        modified,
                        modality,
                        lat,
                        lon,
                        timestamp: exif_timestamp,
                    });
                }
            }
            if last_emit.elapsed().as_millis() > 120 {
                let _ = app.emit(
                    "scan_progress",
                    serde_json::json!({
                      "path": path,
                      "processed": processed,
                      "total": 0, // unknown until end
                      "matched": count
                    }),
                );
                last_emit = std::time::Instant::now();
            }
            if throttle > 0 && (processed % sleep_every == 0) {
                // cooperative yield to keep disk + UI responsive
                sleep(std::time::Duration::from_millis(throttle)).await;
            }
        }
    }
    let _ = app.emit(
        "scan_progress",
        serde_json::json!({
          "path": path,
          "processed": processed,
          "total": processed, // final total
          "matched": count,
          "done": true
        }),
    );
    Ok(ScanResult {
        count,
        samples,
        items,
    })
}

#[tauri::command]
async fn stop_scan() -> Result<(), String> {
    CANCEL_SCAN.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
async fn set_default_throttle(ms: u64) -> Result<(), String> {
    let mut guard = DEFAULT_THROTTLE_VALUE.lock().map_err(|_| "lock poisoned")?;
    *guard = ms;
    Ok(())
}
#[derive(serde::Deserialize, serde::Serialize)]
struct SyncPayloadItem {
    user_id: String,
    modality: String,
    uri: String,
    ts: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes_b64: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct SyncPayload {
    items: Vec<SyncPayloadItem>,
}

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone)]
struct SyncErrorItem {
    uri: String,
    error: String,
}

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone)]
struct SyncResult {
    upserted: usize,
    embedded_images: Option<usize>,
    embedded_success: Option<usize>,
    embedded_failed: Option<usize>,
    requested_embeds: Option<usize>,
    queued_embeds: Option<usize>,
    embed_queue_depth: Option<usize>,
    embed_errors: Option<Vec<SyncErrorItem>>,
    read_errors: Option<Vec<SyncErrorItem>>,
}

#[tauri::command]
async fn sync_index(server_url: String, payload: SyncPayload) -> Result<SyncResult, String> {
    if server_url.is_empty() {
        return Err("server_url empty".into());
    }
    let trimmed = server_url.trim_end_matches('/');
    if payload.items.is_empty() {
        return Ok(SyncResult {
            upserted: 0,
            embedded_images: Some(0),
            embedded_success: Some(0),
            embedded_failed: Some(0),
            requested_embeds: Some(0),
            queued_embeds: Some(0),
            embed_queue_depth: Some(0),
            embed_errors: Some(Vec::new()),
            read_errors: Some(Vec::new()),
        });
    }

    let url = format!("{}/sync/stream", trimmed);
    let client = reqwest::Client::new();

    let stream =
        stream::iter(
            payload
                .items
                .into_iter()
                .map(|item| match serde_json::to_string(&item) {
                    Ok(line) => Ok::<Bytes, io::Error>(Bytes::from(line + "\n")),
                    Err(err) => Err(io::Error::new(io::ErrorKind::Other, err)),
                }),
        );

    let body = reqwest::Body::wrap_stream(stream);

    let resp = client
        .post(url)
        .header("Content-Type", "application/x-ndjson")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("sync failed: {}", resp.status()));
    }
    let result = resp.json::<SyncResult>().await.map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
async fn filter_indexed(
    server_url: String,
    payload: SyncPayload,
) -> Result<Vec<SyncPayloadItem>, String> {
    if server_url.is_empty() {
        return Err("server_url empty".into());
    }
    if payload.items.is_empty() {
        return Ok(Vec::new());
    }
    let trimmed = server_url.trim_end_matches('/');
    let first_user = payload.items[0].user_id.clone();
    if first_user.is_empty() {
        return Ok(payload.items);
    }
    if payload
        .items
        .iter()
        .any(|item| item.user_id != first_user)
    {
        return Err("mixed user ids unsupported".into());
    }
    let mut seen = HashSet::new();
    let mut uris: Vec<String> = Vec::new();
    for item in &payload.items {
        let trimmed_uri = item.uri.trim();
        if trimmed_uri.is_empty() {
            continue;
        }
        if seen.insert(trimmed_uri.to_string()) {
            uris.push(trimmed_uri.to_string());
        }
    }
    if uris.is_empty() {
        return Ok(payload.items);
    }

    #[derive(serde::Serialize)]
    struct MissingRequest {
        user_id: String,
        uris: Vec<String>,
    }

    #[derive(serde::Deserialize)]
    struct MissingResponse {
        missing: Vec<String>,
    }

    let request = MissingRequest {
        user_id: first_user.clone(),
        uris,
    };

    let url = format!("{}/sync/missing", trimmed);
    let client = reqwest::Client::new();
    let resp = client
        .post(url)
        .json(&request)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("missing probe failed: {}", resp.status()));
    }
    let missing = resp
        .json::<MissingResponse>()
        .await
        .map_err(|e| e.to_string())?;
    if missing.missing.is_empty() {
        return Ok(Vec::new());
    }
    let missing_set: HashSet<String> = missing.missing.into_iter().collect();
    let filtered: Vec<SyncPayloadItem> = payload
        .items
        .into_iter()
        .filter(|item| {
            if item.uri.trim().is_empty() {
                return true;
            }
            missing_set.contains(item.uri.trim())
        })
        .collect();
    Ok(filtered)
}

#[tauri::command]
async fn show_overlay(app: tauri::AppHandle) -> Result<(), String> {
    if !ensure_authenticated(&app).await? {
        return Err("not authenticated".into());
    }
    if let Some(overlay_window) = app.get_webview_window("overlay") {
        overlay_window.show().map_err(|e| e.to_string())?;
        overlay_window.set_focus().map_err(|e| e.to_string())?;
        // Emit the toggle-overlay event to focus the input
        let _ = app.emit("toggle-overlay", ());
    }
    Ok(())
}

#[tauri::command]
async fn toggle_overlay(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(overlay_window) = app.get_webview_window("overlay") {
        if overlay_window.is_visible().map_err(|e| e.to_string())? {
            overlay_window.hide().map_err(|e| e.to_string())?;
        } else {
            if !ensure_authenticated(&app).await? {
                return Err("not authenticated".into());
            }
            overlay_window.show().map_err(|e| e.to_string())?;
            overlay_window.set_focus().map_err(|e| e.to_string())?;
            // Emit the toggle-overlay event to focus the input
            let _ = app.emit("toggle-overlay", ());
        }
    }
    Ok(())
}

async fn ensure_authenticated(app: &tauri::AppHandle) -> Result<bool, String> {
    let session = get_session(app.clone()).await?;
    if session.is_some() {
        return Ok(true);
    }
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.show();
        let _ = main_window.set_focus();
    }
    Ok(false)
}

#[tauri::command]
async fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(main_window) = app.get_webview_window("main") {
        main_window.show().map_err(|e| e.to_string())?;
        main_window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn open_file(path: String) -> Result<(), String> {
    if path.is_empty() {
        return Err("path empty".into());
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            get_default_folder,
            pick_folder,
            scan_folder,
            stop_scan,
            set_default_throttle,
            filter_indexed,
            sync_index,
            show_overlay,
            toggle_overlay,
            show_main_window,
            open_file,
            google_auth_start,
            get_session,
            logout,
            refresh_session,
            ensure_fresh_session
        ])
        .setup(|app| {
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                use tauri_plugin_global_shortcut::ShortcutState;

                let shortcut_str = if cfg!(target_os = "macos") {
                    "command+shift+k"
                } else {
                    "ctrl+shift+k"
                };

                match tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcut(shortcut_str)
                {
                    Ok(builder) => {
                        let plugin = builder
                            .with_handler(|app_handle, _shortcut, event| {
                                if event.state == ShortcutState::Pressed {
                                    let handle = app_handle.clone();
                                    tauri::async_runtime::spawn(async move {
                                        let _ = show_overlay(handle).await;
                                    });
                                }
                            })
                            .build();

                        if let Err(err) = app.handle().plugin(plugin) {
                            if err
                                .to_string()
                                .contains("HotKey already registered")
                            {
                                log::warn!(
                                    "Global shortcut {} already registered elsewhere; overlay toggle remains available via UI",
                                    shortcut_str
                                );
                            } else {
                                return Err(Box::new(err));
                            }
                        }
                    }
                    Err(err) => {
                        log::warn!(
                            "Failed to configure global shortcut {}: {}",
                            shortcut_str,
                            err
                        );
                    }
                }
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
