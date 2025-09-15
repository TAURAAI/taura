package handlers

import (
	"context"
	"time"
	"strings"
	"github.com/gofiber/fiber/v2"
	"github.com/TAURAAI/taura/api-gateway/internal/db"
	// "github.com/TAURAAI/taura/api-gateway/internal/embed"
	"log"
)

type MediaUpsert struct {
	UserID   string  `json:"user_id"`
	Modality string  `json:"modality"`
	URI      string  `json:"uri"`
	TS       *string `json:"ts"`
	Lat      *float64 `json:"lat"`
	Lon      *float64 `json:"lon"`
	Album    *string `json:"album"`
	Source   *string `json:"source"`
}

type SyncRequest struct {
	Items []MediaUpsert `json:"items"`
}

func PostSync(c *fiber.Ctx) error {
	var req SyncRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	database, ok := c.Locals("db").(*db.Database)
	if !ok || database == nil { return fiber.NewError(fiber.StatusInternalServerError, "db missing") }
	ctx := context.Background()
	tx, err := database.Pool.Begin(ctx)
	if err != nil { return fiber.NewError(fiber.StatusInternalServerError, "tx begin") }
	defer tx.Rollback(ctx)

	upserted := 0
	for _, item := range req.Items {
		if item.UserID == "" || item.URI == "" || item.Modality == "" { continue }
		var tsPtr *time.Time
		if item.TS != nil && *item.TS != "" {
			// parse RFC3339 (fallback ignore)
			if t, err := time.Parse(time.RFC3339, *item.TS); err == nil { tsPtr = &t }
		}
		// Basic insertion (id generated via SQL DEFAULT)
		// Use ON CONFLICT on (user_id, uri) if unique index later.
		sql := `INSERT INTO media (user_id, modality, uri, ts, album, source, lat, lon)
						VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
						ON CONFLICT (id) DO NOTHING
						RETURNING id`
		var mediaID string
		err = tx.QueryRow(ctx, sql, item.UserID, item.Modality, item.URI, tsPtr, item.Album, item.Source, item.Lat, item.Lon).Scan(&mediaID)
		if err != nil {
			log.Printf("media insert error uri=%s err=%v", item.URI, err)
			continue
		}
		upserted++
		// Embed based on modality (simple heuristic: if image-like) and store vector
		lowerMod := strings.ToLower(item.Modality)
		if lowerMod == "image" || lowerMod == "pdf_page" { // for now text embedding not handled here
			// We don't have image bytes here (privacy); placeholder skip. Could queue job.
			// For MVP assume client will send textual alt (not implemented) so skip.
			continue
		}
		// If modality is text in future: vec, _ := embed.Text(ctx, item.URI)
	}
	if err := tx.Commit(ctx); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "tx commit")
	}
	return c.JSON(fiber.Map{"upserted": upserted})
}
