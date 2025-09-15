#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[derive(serde::Serialize)]
struct MediaMeta {
  path: String,
  size: u64,
  modified: Option<String>,
  modality: String,
}

#[derive(serde::Serialize)]
struct ScanResult {
  count: usize,
  samples: Vec<String>,
  items: Vec<MediaMeta>,
}

fn is_media_file(entry: &std::path::Path) -> bool {
  match entry.extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase()) {
    Some(ext) => matches!(ext.as_str(), "jpg"|"jpeg"|"png"|"gif"|"webp"|"bmp"|"tiff"|"tif"|"heic"|"heif"|"pdf"),
    None => false,
  }
}

#[tauri::command]
async fn scan_folder(path: String, max_samples: Option<usize>) -> Result<ScanResult, String> {
  if path.is_empty() { return Err("path empty".into()); }
  let limit = max_samples.unwrap_or(10);
  let mut samples = Vec::new();
  let mut count: usize = 0;
  let mut items: Vec<MediaMeta> = Vec::new();
  let walker = walkdir::WalkDir::new(&path).follow_links(false).max_depth(8);
  for entry in walker {
    let entry = match entry { Ok(e) => e, Err(_) => continue };
    if entry.file_type().is_file() {
      let p = entry.path();
      if is_media_file(p) {
        count += 1;
        if samples.len() < limit {
          if let Some(s) = p.to_str() { samples.push(s.to_string()); }
        }
        // metadata
        let mut size: u64 = 0; let mut modified: Option<String> = None;
        if let Ok(md) = entry.metadata() {
          size = md.len();
          if let Ok(mt) = md.modified() {
            let dt: chrono::DateTime<chrono::Utc> = mt.into();
            modified = Some(dt.to_rfc3339());
          }
        }
        let modality = match p.extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase()) {
          Some(ext) if ext == "pdf" => "pdf_page".to_string(),
          _ => "image".to_string(),
        };
        if let Some(s) = p.to_str() { items.push(MediaMeta { path: s.to_string(), size, modified, modality }); }
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

pub fn run() {
  tauri::Builder::default()
  .invoke_handler(tauri::generate_handler![scan_folder, sync_index])
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
