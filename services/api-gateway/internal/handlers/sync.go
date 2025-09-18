package handlers

import (
	"context"
	"fmt"
	"github.com/TAURAAI/taura/api-gateway/internal/db"
	"github.com/TAURAAI/taura/api-gateway/internal/embed"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgconn"
	"io/ioutil"
	"log"
	"strings"
	"time"
)

// NOTE: We use a savepoint per item so a single bad record does not poison the whole transaction.
// Always rollback to the item's savepoint on ANY error that could set the tx in failed state
// before attempting further statements. Otherwise PostgreSQL returns 25P02 and ignores subsequent commands.

type MediaUpsert struct {
	UserID   string   `json:"user_id"`
	Modality string   `json:"modality"`
	URI      string   `json:"uri"`
	TS       *string  `json:"ts"`
	Lat      *float64 `json:"lat"`
	Lon      *float64 `json:"lon"`
	Album    *string  `json:"album"`
	Source   *string  `json:"source"`
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
	if !ok || database == nil {
		return fiber.NewError(fiber.StatusInternalServerError, "db missing")
	}

	// --- Pre-resolve any non-UUID user identifiers (treated as email) outside the media transaction ---
	userMap := make(map[string]string) // external -> uuid
	for _, item := range req.Items {
		if item.UserID == "" { continue }
		if _, ok := userMap[item.UserID]; ok { continue }
		if _, err := uuid.Parse(item.UserID); err == nil {
			userMap[item.UserID] = item.UserID
			continue
		}
		// Resolve via upsert outside big media tx to isolate errors
		var resolved string
		uq := `INSERT INTO users (email) VALUES ($1)
				ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id`
		if err := database.Pool.QueryRow(context.Background(), uq, item.UserID).Scan(&resolved); err != nil {
			log.Printf("user pre-resolve failed ext=%s err=%v", item.UserID, err)
			continue // leave unresolved; item will be skipped later
		}
		userMap[item.UserID] = resolved
	}
	ctx := context.Background()
	tx, err := database.Pool.Begin(ctx)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "tx begin")
	}
	defer tx.Rollback(ctx)

	upserted := 0
	type pendingImage struct {
		mediaID string
		uri     string
		bytes   []byte
	}
	var pending []pendingImage
	for idx, item := range req.Items {
		if item.UserID == "" || item.URI == "" || item.Modality == "" { continue }
		userUUID, ok := userMap[item.UserID]
		if !ok { // unresolved email earlier
			continue
		}
		spName := fmt.Sprintf("sp_%d", idx)
		if _, err := tx.Exec(ctx, "SAVEPOINT "+spName); err != nil {
			log.Printf("savepoint create failed idx=%d err=%v", idx, err)
			// if savepoint creation itself fails with 25P02, break to avoid log spam
			break
		}

		var tsPtr *time.Time
		if item.TS != nil && *item.TS != "" {
			if t, err := time.Parse(time.RFC3339, *item.TS); err == nil {
				tsPtr = &t
			}
		}

		var mediaID string
		insertMedia := `INSERT INTO media (user_id, modality, uri, ts, album, source, lat, lon)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
					ON CONFLICT (user_id, uri) DO NOTHING
					RETURNING id`
		errIns := tx.QueryRow(ctx, insertMedia, userUUID, item.Modality, item.URI, tsPtr, item.Album, item.Source, item.Lat, item.Lon).Scan(&mediaID)
		if errIns != nil {
			// No row returned likely due to ON CONFLICT DO NOTHING; attempt select outside rollback path first
			if pgErr, ok := errIns.(*pgconn.PgError); ok {
				log.Printf("media insert pg error uri=%s code=%s msg=%s", item.URI, pgErr.Code, pgErr.Message)
				if _, rbErr := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT "+spName); rbErr != nil {
					log.Printf("rollback to savepoint failed idx=%d err=%v", idx, rbErr)
					continue
				}
				row := tx.QueryRow(ctx, `SELECT id FROM media WHERE user_id=$1 AND uri=$2 LIMIT 1`, userUUID, item.URI)
				if errSel := row.Scan(&mediaID); errSel != nil { continue }
			} else {
				// Non-pg error (e.g. no rows) treat as existing row path
				row := tx.QueryRow(ctx, `SELECT id FROM media WHERE user_id=$1 AND uri=$2 LIMIT 1`, userUUID, item.URI)
				if errSel := row.Scan(&mediaID); errSel != nil { continue }
			}
		} else { upserted++ }

		lowerMod := strings.ToLower(item.Modality)
		if lowerMod == "image" || lowerMod == "pdf_page" {
			if strings.HasPrefix(item.URI, "C:\\") || strings.HasPrefix(item.URI, "/") || strings.HasPrefix(item.URI, "\\\\") {
				bytes, readErr := ioutil.ReadFile(item.URI)
				if readErr != nil {
					log.Printf("read file for embed failed uri=%s err=%v", item.URI, readErr)
				} else if len(bytes) == 0 {
					log.Printf("skip embed for empty file uri=%s", item.URI)
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
		if end > len(pending) {
			end = len(pending)
		}
		batch := pending[i:end]
		batchBytes := 0
		for _, p := range batch { batchBytes += len(p.bytes) }
		startBatch := time.Now()
		payload := make([][]byte, len(batch))
		for j, p := range batch {
			payload[j] = p.bytes
		}
		vecs, errs, errBatch := embed.ImageBatch(ctx, payload)
		elapsed := time.Since(startBatch)
		if errBatch != nil {
			log.Printf("image batch embed error start=%d count=%d bytes=%d elapsed=%dms err=%v", i, len(batch), batchBytes, elapsed.Milliseconds(), errBatch)
			continue
		}
		log.Printf("image batch embed ok start=%d count=%d bytes=%d elapsed=%dms", i, len(batch), batchBytes, elapsed.Milliseconds())
		for j, vec := range vecs {
			if len(vec) == 0 {
				if errs != nil && errs[j] != "" {
					log.Printf("embed image failed uri=%s err=%s", batch[j].uri, errs[j])
				}
				continue
			}
			parts := make([]string, len(vec))
			for k, f := range vec {
				parts[k] = fmt.Sprintf("%.9f", f)
			}
			vectorLiteral := "[" + strings.Join(parts, ",") + "]"
			if _, insErr := database.Pool.Exec(ctx, `INSERT INTO media_vecs (media_id, embedding) VALUES ($1, $2::vector)
				ON CONFLICT (media_id) DO UPDATE SET embedding=EXCLUDED.embedding`, batch[j].mediaID, vectorLiteral); insErr != nil {
				log.Printf("media_vecs upsert error media_id=%s err=%v", batch[j].mediaID, insErr)
			}
		}
	}

	return c.JSON(fiber.Map{"upserted": upserted, "embedded_images": len(pending)})
}
