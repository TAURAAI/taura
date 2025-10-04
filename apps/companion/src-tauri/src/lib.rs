use tauri::{Manager, Emitter};
use tokio::time::sleep; // for throttled scan yielding
use std::sync::atomic::{AtomicBool, Ordering};
use once_cell::sync::Lazy;

// Cancellation + config state
static CANCEL_SCAN: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));
static DEFAULT_THROTTLE_VALUE: Lazy<std::sync::Mutex<u64>> = Lazy::new(|| std::sync::Mutex::new(40)); // 40ms gentle by default
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
  match entry.extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase()) {
    Some(ext) => matches!(ext.as_str(), "jpg"|"jpeg"|"png"|"gif"|"webp"|"bmp"|"tiff"|"tif"|"heic"|"heif"|"pdf"|"mp4"|"mov"|"avi"|"mkv"),
    None => false,
  }
}

#[tauri::command]
async fn get_default_folder() -> Result<String, String> {
  let home_dir = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME"))
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
async fn scan_folder(path: String, max_samples: Option<usize>, throttle_ms: Option<u64>, app: tauri::AppHandle) -> Result<ScanResult, String> {
  if path.is_empty() { return Err("path empty".into()); }
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
  let _ = app.emit("scan_progress", serde_json::json!({
    "path": path,
    "processed": 0,
    "total": 0,
    "matched": 0
  }));

  let sleep_every = 32usize; // after how many files to apply sleep
  let throttle = throttle_ms.or_else(|| {
    // use stored default throttle if user didn't explicitly pass one
    Some(*DEFAULT_THROTTLE_VALUE.lock().unwrap())
  }).unwrap_or(0);
  for entry in walker {
    if CANCEL_SCAN.load(Ordering::SeqCst) {
      let _ = app.emit("scan_progress", serde_json::json!({
        "path": path,
        "processed": processed,
        "total": processed,
        "matched": count,
        "cancelled": true,
        "done": true
      }));
      return Ok(ScanResult { count, samples, items });
    }
    let entry = match entry { Ok(e) => e, Err(_) => continue };
    if entry.file_type().is_file() {
      processed += 1;
      let p = entry.path();
      if is_media_file(p) {
        count += 1;
        if samples.len() < limit { if let Some(s) = p.to_str() { samples.push(s.to_string()); } }
        let mut size: u64 = 0; 
        let mut modified: Option<String> = None;
        if let Ok(md) = entry.metadata() {
          size = md.len();
          if let Ok(mt) = md.modified() { let dt: chrono::DateTime<chrono::Utc> = mt.into(); modified = Some(dt.to_rfc3339()); }
        }
        let (lat, lon, exif_timestamp) = (None, None, None);
        let modality = match p.extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase()) {
          Some(ext) if ext == "pdf" => "pdf_page".to_string(),
          Some(ext) if matches!(ext.as_str(), "mp4"|"mov"|"avi"|"mkv") => "video".to_string(),
          _ => "image".to_string(),
        };
        if let Some(s) = p.to_str() { items.push(MediaMeta { path: s.to_string(), size, modified, modality, lat, lon, timestamp: exif_timestamp }); }
      }
      if last_emit.elapsed().as_millis() > 120 {
        let _ = app.emit("scan_progress", serde_json::json!({
          "path": path,
          "processed": processed,
          "total": 0, // unknown until end
          "matched": count
        }));
        last_emit = std::time::Instant::now();
      }
      if throttle > 0 && (processed % sleep_every == 0) {
        // cooperative yield to keep disk + UI responsive
        sleep(std::time::Duration::from_millis(throttle)).await;
      }
    }
  }
  let _ = app.emit("scan_progress", serde_json::json!({
    "path": path,
    "processed": processed,
    "total": processed, // final total
    "matched": count,
    "done": true
  }));
  Ok(ScanResult { count, samples, items })
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
  bytes_b64: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct SyncPayload { items: Vec<SyncPayloadItem> }

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
  embed_errors: Option<Vec<SyncErrorItem>>,
  read_errors: Option<Vec<SyncErrorItem>>,
}

#[tauri::command]
async fn sync_index(server_url: String, payload: SyncPayload) -> Result<SyncResult, String> {
  if server_url.is_empty() { return Err("server_url empty".into()); }
  let url = format!("{}/sync", server_url.trim_end_matches('/'));
  let client = reqwest::Client::new();
  let resp = client.post(url).json(&payload).send().await.map_err(|e| e.to_string())?;
  if !resp.status().is_success() { return Err(format!("sync failed: {}", resp.status())); }
  let result = resp.json::<SyncResult>().await.map_err(|e| e.to_string())?;
  Ok(result)
}

#[tauri::command]
async fn show_overlay(app: tauri::AppHandle) -> Result<(), String> {
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
      overlay_window.show().map_err(|e| e.to_string())?;
      overlay_window.set_focus().map_err(|e| e.to_string())?;
      // Emit the toggle-overlay event to focus the input
      let _ = app.emit("toggle-overlay", ());
    }
  }
  Ok(())
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
  if path.is_empty() { return Err("path empty".into()); }
  #[cfg(target_os = "windows")]
  {
    Command::new("cmd").args(["/C", "start", "", &path]).spawn().map_err(|e| e.to_string())?;
  }
  #[cfg(target_os = "macos")]
  {
    Command::new("open").arg(&path).spawn().map_err(|e| e.to_string())?;
  }
  #[cfg(target_os = "linux")]
  {
    Command::new("xdg-open").arg(&path).spawn().map_err(|e| e.to_string())?;
  }
  Ok(())
}

pub fn run() {
  #[cfg(not(target_os = "macos"))]
  let shortcut_str = "Ctrl+Shift+K";
  #[cfg(target_os = "macos")]
  let shortcut_str = "Command+Shift+K";

  let shortcut_builder = tauri_plugin_global_shortcut::Builder::new()
    .with_shortcut(shortcut_str)
    .expect("register shortcut definition")
    .with_handler(|app_handle, _shortcut, _event| {
      let h = app_handle.clone();
      tauri::async_runtime::spawn(async move { 
        let _ = show_overlay(h).await;
      });
    })
    .build();

  tauri::Builder::default()
    .plugin(shortcut_builder)
    .plugin(tauri_plugin_fs::init())
    .invoke_handler(tauri::generate_handler![
      get_default_folder,
      pick_folder,
      scan_folder,
      stop_scan,
      set_default_throttle,
      sync_index,
      show_overlay,
      toggle_overlay,
      show_main_window,
      open_file
    ])
    .setup(|app| {
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
