package handlers

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "os"
    "strings"
    "time"
    "github.com/gofiber/fiber/v2"
    "github.com/TAURAAI/taura/api-gateway/internal/db"
)

type GoogleAuthRequest struct {
    IDToken string `json:"id_token"`
    Email   string `json:"email,omitempty"`
    Name    string `json:"name,omitempty"`
    Picture string `json:"picture,omitempty"`
}

type GoogleAuthResponse struct {
    UserID  string `json:"user_id"`
    Email   string `json:"email"`
    Name    string `json:"name,omitempty"`
    Picture string `json:"picture,omitempty"`
}

type tokenInfo struct {
    Aud           string `json:"aud"`
    Email         string `json:"email"`
    EmailVerified string `json:"email_verified"`
    Exp           string `json:"exp"`
    Sub           string `json:"sub"`
}

func PostAuthGoogle(c *fiber.Ctx) error {
    var req GoogleAuthRequest
    if err := c.BodyParser(&req); err != nil {
        return fiber.NewError(fiber.StatusBadRequest, "invalid body")
    }
    idTok := strings.TrimSpace(req.IDToken)
    if idTok == "" { return fiber.NewError(fiber.StatusBadRequest, "id_token required") }

    clientID := strings.TrimSpace(os.Getenv("GOOGLE_CLIENT_ID"))
    if clientID == "" {
        log.Printf("[AUTH] WARNING: GOOGLE_CLIENT_ID not set; skipping aud check")
    }

    verifyStart := time.Now()
    httpClient := &http.Client{ Timeout: 6 * time.Second }
    resp, err := httpClient.Get("https://oauth2.googleapis.com/tokeninfo?id_token=" + idTok)
    if err != nil { return fiber.NewError(fiber.StatusBadGateway, "token verify network error") }
    defer resp.Body.Close()
    if resp.StatusCode != 200 { return fiber.NewError(fiber.StatusUnauthorized, fmt.Sprintf("token verify failed status=%d", resp.StatusCode)) }
    var ti tokenInfo
    if err := json.NewDecoder(resp.Body).Decode(&ti); err != nil {
        return fiber.NewError(fiber.StatusBadGateway, "token decode failed")
    }
    log.Printf("[AUTH] tokeninfo fetched in %dms aud=%s email=%s sub=%s", time.Since(verifyStart).Milliseconds(), ti.Aud, ti.Email, ti.Sub)
    if clientID != "" && ti.Aud != clientID {
        return fiber.NewError(fiber.StatusUnauthorized, "aud mismatch")
    }
    email := strings.TrimSpace(strings.ToLower(req.Email))
    if email == "" { email = strings.TrimSpace(strings.ToLower(ti.Email)) }
    if email == "" { return fiber.NewError(fiber.StatusBadRequest, "email unavailable in token") }

    database, ok := c.Locals("db").(*db.Database)
    if !ok || database == nil { return fiber.NewError(fiber.StatusInternalServerError, "db missing") }
    ctx := context.Background()
    var id string
    if err := database.Pool.QueryRow(ctx, `INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id`, email).Scan(&id); err != nil {
        log.Printf("[AUTH] upsert user failed email=%s err=%v", email, err)
        return fiber.NewError(fiber.StatusInternalServerError, "upsert failed")
    }
    return c.JSON(GoogleAuthResponse{ UserID: id, Email: email, Name: req.Name, Picture: req.Picture })
}
