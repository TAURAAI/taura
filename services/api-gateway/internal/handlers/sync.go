package handlers

import (
	"context"
	"errors"
	"github.com/TAURAAI/taura/api-gateway/internal/db"
	"github.com/TAURAAI/taura/api-gateway/internal/embed"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgconn"
	"log"
	"os"
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

type failureDetail struct {
	URI   string `json:"uri"`
	Error string `json:"error"`
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

	syncVersionOnce.Do(func() { log.Printf("/sync handler revision=3 (conflict-safe CTE upserts)") })

	ctx := context.Background()

	resolveUser := func(raw string) (string, bool) {
		if raw == "" {
			return "", false
		}
		if _, err := uuid.Parse(raw); err == nil {
			return raw, true
		}
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
	var readFailures []failureDetail
	requestedEmbeds := 0
	queuedEmbeds := 0
	embedFailures := []failureDetail{}
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
		if item.UserID == "" || item.URI == "" || item.Modality == "" {
			continue
		}
		userUUID, ok := resolveUser(item.UserID)
		if !ok {
			continue
		}
		var tsPtr *time.Time
		if item.TS != nil && *item.TS != "" {
			if t, err := time.Parse(time.RFC3339, *item.TS); err == nil {
				tsPtr = &t
			}
		}
		var mediaID string
		var inserted bool
		err := database.Pool.QueryRow(ctx, mediaUpsertStmt, userUUID, item.Modality, item.URI, tsPtr, item.Album, item.Source, item.Lat, item.Lon).Scan(&mediaID, &inserted)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) {
				if pgErr.Code == "23505" { // duplicate (should be handled by ON CONFLICT) silently ignore
					if selErr := database.Pool.QueryRow(ctx, `SELECT id FROM media WHERE user_id=$1 AND uri=$2`, userUUID, item.URI).Scan(&mediaID); selErr != nil {
						continue
					}
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
		if inserted {
			upserted++
		}
		lower := strings.ToLower(item.Modality)
		if lower == "image" || lower == "pdf_page" {
			if strings.HasPrefix(item.URI, "C:\\") || strings.HasPrefix(item.URI, "/") || strings.HasPrefix(item.URI, "\\\\") {
				bytes, readErr := os.ReadFile(item.URI)
				if readErr != nil {
					msg := readErr.Error()
					readFailures = append(readFailures, failureDetail{URI: item.URI, Error: msg})
					log.Printf("/sync read failure uri=%s err=%s", item.URI, msg)
					continue
				}
				if len(bytes) == 0 {
					readFailures = append(readFailures, failureDetail{URI: item.URI, Error: "file empty"})
					log.Printf("/sync read failure uri=%s err=file empty", item.URI)
					continue
				}
				requestedEmbeds++
				if err := embed.EnqueueImage(mediaID, item.URI, bytes); err != nil {
					embedFailures = append(embedFailures, failureDetail{URI: item.URI, Error: err.Error()})
					log.Printf("/sync enqueue failed uri=%s err=%s", item.URI, err)
				} else {
					queuedEmbeds++
					queueDepthNow := embed.QueueDepth()
					log.Printf("/sync enqueued uri=%s media_id=%s queue_depth=%d", item.URI, mediaID, queueDepthNow)
				}
			}
		}
	}

	embedStatus := embed.HealthSnapshot()
	queueDepth := embed.QueueDepth()
	log.Printf(
		"/sync summary items=%d requested=%d queued=%d read_failures=%d embed_failures=%d queue_depth=%d embedder_healthy=%v last_success=%s last_error=%s",
		len(req.Items),
		requestedEmbeds,
		queuedEmbeds,
		len(readFailures),
		len(embedFailures),
		queueDepth,
		embedStatus.Healthy,
		embedStatus.LastSuccess.Format(time.RFC3339),
		embedStatus.LastError,
	)

	return c.JSON(fiber.Map{
		"upserted":          upserted,
		"embedded_images":   queuedEmbeds,
		"embedded_success":  queuedEmbeds,
		"embedded_failed":   requestedEmbeds - queuedEmbeds,
		"embed_errors":      embedFailures,
		"read_errors":       readFailures,
		"requested_embeds":  requestedEmbeds,
		"queued_embeds":     queuedEmbeds,
		"embed_queue_depth": queueDepth,
		"embedder_status":   embedStatus,
	})
}
