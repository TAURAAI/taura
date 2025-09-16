use tauri::Manager;
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
async fn scan_folder(path: String, max_samples: Option<usize>) -> Result<ScanResult, String> {
  if path.is_empty() { return Err("path empty".into()); }
  let limit = max_samples.unwrap_or(10);
  let mut samples = Vec::new();
  let mut count: usize = 0;
  let mut items: Vec<MediaMeta> = Vec::new();
  let walker = WalkDir::new(&path).follow_links(false).max_depth(8);
  
  for entry in walker {
    let entry = match entry { Ok(e) => e, Err(_) => continue };
    if entry.file_type().is_file() {
      let p = entry.path();
      if is_media_file(p) {
        count += 1;
        if samples.len() < limit {
          if let Some(s) = p.to_str() { samples.push(s.to_string()); }
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
        
        let modality = match p.extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase()) {
          Some(ext) if ext == "pdf" => "pdf_page".to_string(),
          Some(ext) if matches!(ext.as_str(), "mp4"|"mov"|"avi"|"mkv") => "video".to_string(),
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
    }
  }
  Ok(ScanResult { count, samples, items })
}

#[derive(serde::Deserialize, serde::Serialize)]
struct SyncPayloadItem {
  user_id: String,
  modality: String,
  uri: String,
  ts: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct SyncPayload { items: Vec<SyncPayloadItem> }

#[tauri::command]
async fn sync_index(server_url: String, payload: SyncPayload) -> Result<usize, String> {
  if server_url.is_empty() { return Err("server_url empty".into()); }
  let url = format!("{}/sync", server_url.trim_end_matches('/'));
  let client = reqwest::Client::new();
  let resp = client.post(url).json(&payload).send().await.map_err(|e| e.to_string())?;
  if !resp.status().is_success() { return Err(format!("sync failed: {}", resp.status())); }
  let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
  Ok(v.get("upserted").and_then(|x| x.as_u64()).unwrap_or(0) as usize)
}

#[tauri::command]
async fn toggle_overlay(app: tauri::AppHandle) -> Result<(), String> {
  if let Some(overlay_window) = app.get_webview_window("overlay") {
    let is_visible = overlay_window.is_visible().map_err(|e| e.to_string())?;
    if is_visible {
      overlay_window.hide().map_err(|e| e.to_string())?;
    } else {
      overlay_window.show().map_err(|e| e.to_string())?;
      overlay_window.set_focus().map_err(|e| e.to_string())?;
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

pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![get_default_folder, pick_folder, scan_folder, sync_index, toggle_overlay, show_main_window])
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
