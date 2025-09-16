package handlers

import (
	"context"
	"time"
	"strings"
	"fmt"
	"github.com/gofiber/fiber/v2"
	"github.com/TAURAAI/taura/api-gateway/internal/db"
	"github.com/TAURAAI/taura/api-gateway/internal/embed"
	"log"
	"github.com/google/uuid"
	"github.com/jackc/pgconn"
	"encoding/base64"
	"io/ioutil"
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
	for idx, item := range req.Items {
		if item.UserID == "" || item.URI == "" || item.Modality == "" { continue }

		spName := fmt.Sprintf("sp_%d", idx)
		if _, err := tx.Exec(ctx, "SAVEPOINT "+spName); err != nil {
			log.Printf("savepoint create failed idx=%d err=%v", idx, err)
			continue
		}

		userUUID := item.UserID
		if _, err := uuid.Parse(item.UserID); err != nil {
			var resolved string
			uq := `INSERT INTO users (email) VALUES ($1)
						 ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id`
			if err2 := tx.QueryRow(ctx, uq, item.UserID).Scan(&resolved); err2 != nil {
				log.Printf("user resolve error ext=%s err=%v", item.UserID, err2)
				tx.Exec(ctx, "ROLLBACK TO SAVEPOINT "+spName)
				continue
			}
			userUUID = resolved
		}

		var tsPtr *time.Time
		if item.TS != nil && *item.TS != "" {
			if t, err := time.Parse(time.RFC3339, *item.TS); err == nil { tsPtr = &t }
		}

			var mediaID string
			insertMedia := `INSERT INTO media (user_id, modality, uri, ts, album, source, lat, lon)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
					ON CONFLICT (user_id, uri) DO NOTHING
					RETURNING id`
			errIns := tx.QueryRow(ctx, insertMedia, userUUID, item.Modality, item.URI, tsPtr, item.Album, item.Source, item.Lat, item.Lon).Scan(&mediaID)
			if errIns != nil {
				pgErr, ok := errIns.(*pgconn.PgError)
				if ok && (pgErr.Code == "42P10" || pgErr.Code == "42P01") { // no unique constraint / invalid
					row := tx.QueryRow(ctx, `SELECT id FROM media WHERE user_id=$1 AND uri=$2 LIMIT 1`, userUUID, item.URI)
					if errSel := row.Scan(&mediaID); errSel != nil {
						plain := `INSERT INTO media (user_id, modality, uri, ts, album, source, lat, lon)
								VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`
						if errPlain := tx.QueryRow(ctx, plain, userUUID, item.Modality, item.URI, tsPtr, item.Album, item.Source, item.Lat, item.Lon).Scan(&mediaID); errPlain != nil {
							log.Printf("media insert error (no unique index) uri=%s err=%v", item.URI, errPlain)
							tx.Exec(ctx, "ROLLBACK TO SAVEPOINT "+spName)
							continue
						}
					} // else mediaID fetched
				} else {
					row := tx.QueryRow(ctx, `SELECT id FROM media WHERE user_id=$1 AND uri=$2 LIMIT 1`, userUUID, item.URI)
					if errSel := row.Scan(&mediaID); errSel != nil {
						log.Printf("media insert error uri=%s err=%v", item.URI, errIns)
						tx.Exec(ctx, "ROLLBACK TO SAVEPOINT "+spName)
						continue
					}
				}
			} else {
				upserted++
			}

		lowerMod := strings.ToLower(item.Modality)
		if lowerMod == "image" || lowerMod == "pdf_page" {
			// Perform embedding OUTSIDE the savepoint but do not allow failure to break transaction.
			// Convert local file path to base64 to comply with embedder (which disallows raw uri fetch unless ALLOW_LOCAL_URI set).
			isLocal := false
			if strings.HasPrefix(item.URI, "C:\\") || strings.HasPrefix(item.URI, "/") || strings.HasPrefix(item.URI, "\\\\") {
				isLocal = true
			}
			var vec []float32
			var embErr error
			if isLocal {
				bytes, readErr := ioutil.ReadFile(item.URI)
				if readErr != nil {
					log.Printf("read file for embed failed uri=%s err=%v", item.URI, readErr)
				} else {
					b64 := base64.StdEncoding.EncodeToString(bytes)
					vec, embErr = embed.Image(ctx, b64, true)
				}
			} else {
				vec, embErr = embed.Image(ctx, item.URI, false)
			}
			if embErr != nil {
				log.Printf("embed image failed uri=%s err=%v", item.URI, embErr)
			} else if len(vec) > 0 {
				parts := make([]string, len(vec))
				for i, f := range vec { parts[i] = fmt.Sprintf("%.6f", f) }
				vectorLiteral := "[" + strings.Join(parts, ",") + "]"
				if _, insErr := tx.Exec(ctx, `INSERT INTO media_vecs (media_id, embedding) VALUES ($1, $2::vector)
					ON CONFLICT (media_id) DO UPDATE SET embedding=EXCLUDED.embedding`, mediaID, vectorLiteral); insErr != nil {
					log.Printf("media_vecs upsert error media_id=%s err=%v", mediaID, insErr)
				}
			}
		}

		// Release savepoint (no explicit RELEASE needed; move on)
	}
	if err := tx.Commit(ctx); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "tx commit")
	}
	return c.JSON(fiber.Map{"upserted": upserted})
}
