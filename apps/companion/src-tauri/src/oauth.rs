use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{fs, net::TcpListener, path::PathBuf};
use tauri::Manager;

const SESSION_FILE: &str = "session.json";

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct Session {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<i64>,
    pub id_token: Option<String>,
    pub email: Option<String>,
    pub name: Option<String>,
    pub picture: Option<String>,
    pub sub: Option<String>,
    pub client_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
}

fn session_path(app: &tauri::AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_config_dir()
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    base.join(SESSION_FILE)
}

fn load_session(app: &tauri::AppHandle) -> Option<Session> {
    let p = session_path(app);
    if !p.exists() {
        return None;
    }
    let data = fs::read(p).ok()?;
    serde_json::from_slice(&data).ok()
}

fn persist_session(app: &tauri::AppHandle, sess: &Session) -> Result<(), String> {
    let p = session_path(app);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_vec_pretty(sess).map_err(|e| e.to_string())?;
    fs::write(&p, data).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&p).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&p, perms).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_session(app: tauri::AppHandle) -> Result<Option<Session>, String> {
    Ok(load_session(&app))
}

#[tauri::command]
pub async fn logout(app: tauri::AppHandle) -> Result<(), String> {
    let p = session_path(&app);
    if p.exists() {
        let _ = fs::remove_file(p);
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct GoogleAuthConfig {
    #[serde(alias = "clientId", alias = "clientID")]
    client_id: String,
    #[serde(default, alias = "clientSecret", alias = "client_secret")]
    client_secret: Option<String>,
}

#[derive(Serialize)]
pub struct AuthResult {
    pub session: Session,
}

// Simplified loopback PKCE flow for installed apps.
#[tauri::command]
pub async fn google_auth_start(
    app: tauri::AppHandle,
    cfg: GoogleAuthConfig,
) -> Result<AuthResult, String> {
    let client_id = cfg.client_id.trim();
    if client_id.is_empty() {
        return Err("client_id empty (set VITE_TAURA_GOOGLE_CLIENT_ID)".into());
    }
    let client_secret_opt = cfg
        .client_secret
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());

    // --- PKCE code verifier & challenge ---
    use rand::RngCore;
    // Use 48 random bytes -> ~64 URL-safe base64 chars; PKCE requires 43-128
    let mut vr = [0u8; 48];
    rand::rngs::OsRng.fill_bytes(&mut vr);
    let mut code_verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(vr);
    // Safety: ensure length within (43..=128); if shorter, append 'A'; if longer trim
    while code_verifier.len() < 43 { code_verifier.push('A'); }
    if code_verifier.len() > 128 { code_verifier.truncate(128); }
    use sha2::{Digest, Sha256};
    let challenge_hash = Sha256::digest(code_verifier.as_bytes());
    let code_challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(challenge_hash);

    // Loopback ephemeral listener
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let redirect_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{}", redirect_port);

    let state = uuid::Uuid::new_v4().to_string();
    let scope = "openid email profile";
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent",
        urlencoding::encode(client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(scope),
        urlencoding::encode(&state),
        urlencoding::encode(&code_challenge)
    );

    // Open system browser
    if let Err(e) = open::that(&auth_url) {
        return Err(format!("failed to open browser: {}", e));
    }

    // Accept single connection
    let (mut stream, _) = listener.accept().map_err(|e| e.to_string())?;
    use std::io::Read;
    let mut buf = [0u8; 2048];
    let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let line = req.lines().next().unwrap_or("");
    // Expect GET /?code=...&state=...
    let code = {
        // Parse first request line: GET /?code=...&state=... HTTP/1.1
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 { return Err("malformed redirect request".into()); }
        let path_q = parts[1];
        let q_idx = path_q.find('?').ok_or_else(|| "missing query in redirect".to_string())?;
        let qs = &path_q[q_idx + 1..];
        let mut code_opt = None;
        for pair in qs.split('&') {
            let mut kv = pair.splitn(2,'=');
            let k = kv.next().unwrap_or("");
            let v_raw = kv.next().unwrap_or("");
            let v = urlencoding::decode(v_raw).unwrap_or_default().to_string();
            if k == "state" && v != state { return Err("state mismatch".into()); }
            if k == "code" { code_opt = Some(v); }
        }
        code_opt.ok_or_else(|| "authorization code missing".to_string())?
    };

    // Respond basic HTML
    let resp = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<!doctype html><html><body><h3>You can return to Taura.</h3></body></html>";
    use std::io::Write;
    let _ = stream.write_all(resp);

    // Exchange code
    #[derive(Deserialize)]
    struct TokenResp {
        access_token: String,
        expires_in: Option<i64>,
        refresh_token: Option<String>,
        id_token: Option<String>,
        token_type: Option<String>,
        scope: Option<String>,
    }
    // Build form params dynamically (include client_secret if provided for OAuth Web type; Installed App often doesn't need it)
    let mut params: Vec<(&str, &str)> = vec![
        ("client_id", client_id),
        ("code", &code),
        ("code_verifier", &code_verifier),
        ("grant_type", "authorization_code"),
        ("redirect_uri", &redirect_uri),
    ];
    if let Some(cs) = client_secret_opt { params.push(("client_secret", cs)); }
    let client = reqwest::Client::new();
    let token_resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("token request failed: {e}"))?;

    if !token_resp.status().is_success() {
        let status = token_resp.status();
        let body_txt = token_resp.text().await.unwrap_or_default();
        return Err(format!("token exchange failed: {} body={}", status, body_txt));
    }
    let tok = token_resp
        .json::<TokenResp>()
        .await
        .map_err(|e| format!("token decode failed: {e}"))?;

    // Fetch userinfo
    #[derive(Deserialize)]
    struct UserInfo {
        sub: Option<String>,
        email: Option<String>,
        name: Option<String>,
        picture: Option<String>,
    }
    let userinfo = client
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(&tok.access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<UserInfo>()
        .await
        .map_err(|e| e.to_string())?;

    let expires_at = tok
        .expires_in
        .map(|s| chrono::Utc::now().timestamp() + s - 30); // renew 30s early
    let session = Session {
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        expires_at,
        id_token: tok.id_token,
        email: userinfo.email,
        name: userinfo.name,
        picture: userinfo.picture,
        sub: userinfo.sub.clone(),
        client_id: Some(client_id.to_string()),
        client_secret: client_secret_opt.map(|s| s.to_string()),
    };
    persist_session(&app, &session)?;
    Ok(AuthResult { session })
}

async fn do_refresh(app: &tauri::AppHandle, mut existing: Session) -> Result<Session, String> {
    let refresh_token = existing
        .refresh_token
        .clone()
        .ok_or_else(|| "no refresh_token present".to_string())?;
    let client_id = existing
        .client_id
        .clone()
        .ok_or_else(|| "client_id missing from session".to_string())?;
    let client_secret = existing.client_secret.clone();

    #[derive(Deserialize)]
    struct TokenResp {
        access_token: String,
        expires_in: Option<i64>,
        refresh_token: Option<String>,
        id_token: Option<String>,
        token_type: Option<String>,
        scope: Option<String>,
    }

    let mut params_vec: Vec<(&str, &str)> = vec![
        ("client_id", client_id.as_str()),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token.as_str()),
    ];
    if let Some(cs) = client_secret.as_ref() {
        params_vec.push(("client_secret", cs.as_str()));
    }
    let client = reqwest::Client::new();
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&params_vec)
        .send()
        .await
        .map_err(|e| format!("refresh token request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body_txt = resp.text().await.unwrap_or_default();
        return Err(format!("refresh failed: {} body={}", status, body_txt));
    }
    let tok = resp
        .json::<TokenResp>()
        .await
        .map_err(|e| format!("refresh decode failed: {e}"))?;

    existing.access_token = tok.access_token;
    if let Some(rt) = tok.refresh_token {
        existing.refresh_token = Some(rt);
    }
    if let Some(idt) = tok.id_token { existing.id_token = Some(idt); }
    existing.expires_at = tok
        .expires_in
        .map(|s| chrono::Utc::now().timestamp() + s - 30);

    persist_session(app, &existing)?;
    Ok(existing)
}

#[tauri::command]
pub async fn refresh_session(app: tauri::AppHandle) -> Result<Session, String> {
    let sess = load_session(&app).ok_or_else(|| "no session".to_string())?;
    do_refresh(&app, sess).await
}

#[tauri::command]
pub async fn ensure_fresh_session(app: tauri::AppHandle) -> Result<Session, String> {
    let sess = load_session(&app).ok_or_else(|| "no session".to_string())?;
    let now = chrono::Utc::now().timestamp();
    if let Some(exp) = sess.expires_at {
        if exp - now > 60 {
            return Ok(sess);
        }
    }
    do_refresh(&app, sess).await
}
