package handlers

import (
	"context"
	"errors"
	"fmt"
	"github.com/TAURAAI/taura/api-gateway/internal/db"
	"github.com/TAURAAI/taura/api-gateway/internal/embed"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v5"
	"io/ioutil"
	"log"
	"strings"
	"sync"
	"time"
)

// Simplified: per-item upsert (no encompassing transaction). Duplicate key conflicts are handled by
// ON CONFLICT DO UPDATE and never escalate to 23505 spam. We only log unexpected errors.

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

var syncVersionOnce sync.Once

func PostSync(c *fiber.Ctx) error {
	var req SyncRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	database, ok := c.Locals("db").(*db.Database)
	if !ok || database == nil {
		return fiber.NewError(fiber.StatusInternalServerError, "db missing")
	}

	syncVersionOnce.Do(func(){ log.Printf("/sync handler revision=3 (conflict-safe CTE upserts)") })

	ctx := context.Background()

	resolveUser := func(raw string) (string, bool) {
		if raw == "" { return "", false }
		if _, err := uuid.Parse(raw); err == nil { return raw, true }
		var id string
		cte := `WITH ins AS (
			INSERT INTO users (email) VALUES ($1)
			ON CONFLICT (email) DO NOTHING
			RETURNING id)
		SELECT id FROM ins
		UNION ALL
		SELECT id FROM users WHERE email=$1
		LIMIT 1`
		if err := database.Pool.QueryRow(ctx, cte, raw).Scan(&id); err != nil {
			return "", false
		}
		return id, true
	}

	upserted := 0
	type pendingImage struct {
		mediaID string
		uri     string
		bytes   []byte
	}
	var pending []pendingImage
	// Single upsert statement always returning id + inserted flag.
	mediaUpsertStmt := `INSERT INTO media (user_id, modality, uri, ts, album, source, lat, lon)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (user_id, uri) DO UPDATE SET
		  ts = COALESCE(EXCLUDED.ts, media.ts),
		  album = COALESCE(EXCLUDED.album, media.album),
		  source = COALESCE(EXCLUDED.source, media.source),
		  lat = COALESCE(EXCLUDED.lat, media.lat),
		  lon = COALESCE(EXCLUDED.lon, media.lon)
		RETURNING id, (xmax = 0) AS inserted` // xmax=0 heuristic: true for freshly inserted row

	for _, item := range req.Items {
		if item.UserID == "" || item.URI == "" || item.Modality == "" { continue }
		userUUID, ok := resolveUser(item.UserID); if !ok { continue }
		var tsPtr *time.Time
		if item.TS != nil && *item.TS != "" { if t, err := time.Parse(time.RFC3339, *item.TS); err == nil { tsPtr = &t } }
		var mediaID string
		var inserted bool
		err := database.Pool.QueryRow(ctx, mediaUpsertStmt, userUUID, item.Modality, item.URI, tsPtr, item.Album, item.Source, item.Lat, item.Lon).Scan(&mediaID, &inserted)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) {
				if pgErr.Code == "23505" { // duplicate (should be handled by ON CONFLICT) silently ignore
					if selErr := database.Pool.QueryRow(ctx, `SELECT id FROM media WHERE user_id=$1 AND uri=$2`, userUUID, item.URI).Scan(&mediaID); selErr != nil { continue }
					inserted = false
					// no log noise
					goto afterUpsert
				}
			}
			// unexpected error
			log.Printf("media upsert error uri=%s err=%v", item.URI, err)
			continue
		}
	afterUpsert:
		if inserted { upserted++ }
		lower := strings.ToLower(item.Modality)
		if lower == "image" || lower == "pdf_page" {
			if strings.HasPrefix(item.URI, "C:\\") || strings.HasPrefix(item.URI, "/") || strings.HasPrefix(item.URI, "\\\\") {
				bytes, readErr := ioutil.ReadFile(item.URI)
				if readErr != nil { /* silent for common unreadable; optionally log at debug */ } else if len(bytes) > 0 {
					pending = append(pending, pendingImage{mediaID: mediaID, uri: item.URI, bytes: bytes})
				}
			}
		}
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
