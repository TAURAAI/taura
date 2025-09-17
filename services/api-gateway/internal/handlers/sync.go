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
	type pendingImage struct { mediaID string; uri string; bytes []byte }
	var pending []pendingImage
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
			if strings.HasPrefix(item.URI, "C:\\") || strings.HasPrefix(item.URI, "/") || strings.HasPrefix(item.URI, "\\\\") {
				bytes, readErr := ioutil.ReadFile(item.URI)
				if readErr != nil {
					log.Printf("read file for embed failed uri=%s err=%v", item.URI, readErr)
				} else {
					pending = append(pending, pendingImage{mediaID: mediaID, uri: item.URI, bytes: bytes})
				}
			}
		}

		// Release savepoint (no explicit RELEASE needed; move on)
	}
	if err := tx.Commit(ctx); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "tx commit")
	}

	// Batch embed after commit to reduce DB lock time
	const chunk = 16
	for i := 0; i < len(pending); i += chunk {
		end := i + chunk
		if end > len(pending) { end = len(pending) }
		batch := pending[i:end]
		payload := make([][]byte, len(batch))
		for j, p := range batch { payload[j] = p.bytes }
		vecs, errs, errBatch := embed.ImageBatch(ctx, payload)
		if errBatch != nil {
			log.Printf("image batch embed error start=%d err=%v", i, errBatch)
			continue
		}
		for j, vec := range vecs {
			if len(vec) == 0 {
				if errs != nil && errs[j] != "" { log.Printf("embed image failed uri=%s err=%s", batch[j].uri, errs[j]) }
				continue
			}
			parts := make([]string, len(vec))
			for k, f := range vec { parts[k] = fmt.Sprintf("%.6f", f) }
			vectorLiteral := "[" + strings.Join(parts, ",") + "]"
			if _, insErr := database.Pool.Exec(ctx, `INSERT INTO media_vecs (media_id, embedding) VALUES ($1, $2::vector)
				ON CONFLICT (media_id) DO UPDATE SET embedding=EXCLUDED.embedding`, batch[j].mediaID, vectorLiteral); insErr != nil {
				log.Printf("media_vecs upsert error media_id=%s err=%v", batch[j].mediaID, insErr)
			}
		}
	}

	return c.JSON(fiber.Map{"upserted": upserted, "embedded_images": len(pending)})
}
