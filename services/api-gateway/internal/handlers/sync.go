package handlers

import (
	"context"
	"time"
	"strings"
	"github.com/gofiber/fiber/v2"
	"github.com/TAURAAI/taura/api-gateway/internal/db"
	// "github.com/TAURAAI/taura/api-gateway/internal/embed"
	"log"
	"github.com/google/uuid"
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
		userUUID := item.UserID
		if _, err := uuid.Parse(item.UserID); err != nil {
			var resolved string
			q := `SELECT id FROM users WHERE email=$1`
			if err := tx.QueryRow(ctx, q, item.UserID).Scan(&resolved); err != nil {
				ins := `INSERT INTO users (email) VALUES ($1) RETURNING id`
				if err2 := tx.QueryRow(ctx, ins, item.UserID).Scan(&resolved); err2 != nil {
					log.Printf("user resolve error ext=%s err=%v", item.UserID, err2)
					continue
				}
			}
			userUUID = resolved
		}

		var tsPtr *time.Time
		if item.TS != nil && *item.TS != "" {
			if t, err := time.Parse(time.RFC3339, *item.TS); err == nil { tsPtr = &t }
		}
		sql := `INSERT INTO media (user_id, modality, uri, ts, album, source, lat, lon)
						VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
						ON CONFLICT (id) DO NOTHING
						RETURNING id`
		var mediaID string
		err = tx.QueryRow(ctx, sql, userUUID, item.Modality, item.URI, tsPtr, item.Album, item.Source, item.Lat, item.Lon).Scan(&mediaID)
		if err != nil {
			log.Printf("media insert error uri=%s err=%v", item.URI, err)
			continue
		}
		upserted++
		lowerMod := strings.ToLower(item.Modality)
		if lowerMod == "image" || lowerMod == "pdf_page" {
			continue
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "tx commit")
	}
	return c.JSON(fiber.Map{"upserted": upserted})
}
