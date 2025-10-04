package handlers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
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
	BytesB64 *string  `json:"bytes_b64,omitempty"`
}

type SyncRequest struct {
	Items []MediaUpsert `json:"items"`
}

type failureDetail struct {
	URI   string `json:"uri"`
	Error string `json:"error"`
}

type itemResult struct {
	upserted      int
	requested     int
	queued        int
	readFailures  []failureDetail
	embedFailures []failureDetail
}

type syncAccumulator struct {
	upserted      int
	requested     int
	queued        int
	readFailures  []failureDetail
	embedFailures []failureDetail
}

func (s *syncAccumulator) apply(res itemResult) {
	s.upserted += res.upserted
	s.requested += res.requested
	s.queued += res.queued
	if len(res.readFailures) > 0 {
		s.readFailures = append(s.readFailures, res.readFailures...)
	}
	if len(res.embedFailures) > 0 {
		s.embedFailures = append(s.embedFailures, res.embedFailures...)
	}
}

var syncVersionOnce sync.Once

const maxInlinePayloadBytes = 25 * 1024 * 1024

const mediaUpsertStatement = `INSERT INTO media (user_id, modality, uri, ts, album, source, lat, lon)
	VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
	ON CONFLICT (user_id, uri) DO UPDATE SET
	  ts = COALESCE(EXCLUDED.ts, media.ts),
	  album = COALESCE(EXCLUDED.album, media.album),
	  source = COALESCE(EXCLUDED.source, media.source),
	  lat = COALESCE(EXCLUDED.lat, media.lat),
	  lon = COALESCE(EXCLUDED.lon, media.lon)
	RETURNING id, (xmax = 0) AS inserted`

const ensureUserStatement = `WITH ins AS (
	INSERT INTO users (email) VALUES ($1)
	ON CONFLICT (email) DO NOTHING
	RETURNING id)
SELECT id FROM ins
UNION ALL
SELECT id FROM users WHERE email=$1
LIMIT 1`

func resolveUserID(ctx context.Context, database *db.Database, raw string) (string, bool) {
	if raw == "" {
		return "", false
	}
	if _, err := uuid.Parse(raw); err == nil {
		return raw, true
	}
	var id string
	if err := database.Pool.QueryRow(ctx, ensureUserStatement, raw).Scan(&id); err != nil {
		log.Printf("resolve user failed user=%s err=%v", raw, err)
		return "", false
	}
	return id, true
}

func parseTimestamp(ts *string) *time.Time {
	if ts == nil || *ts == "" {
		return nil
	}
	t, err := time.Parse(time.RFC3339, *ts)
	if err != nil {
		return nil
	}
	return &t
}

func upsertMedia(ctx context.Context, database *db.Database, userUUID string, item MediaUpsert) (string, bool, error) {
	var mediaID string
	var inserted bool
	err := database.Pool.QueryRow(ctx, mediaUpsertStatement, userUUID, item.Modality, item.URI, parseTimestamp(item.TS), item.Album, item.Source, item.Lat, item.Lon).Scan(&mediaID, &inserted)
	if err != nil {
		return "", false, err
	}
	return mediaID, inserted, nil
}

func resolveInlineBytes(item MediaUpsert) ([]byte, []failureDetail) {
	var failures []failureDetail
	if item.BytesB64 != nil && *item.BytesB64 != "" {
		decoded, err := base64.StdEncoding.DecodeString(*item.BytesB64)
		if err != nil {
			failures = append(failures, failureDetail{URI: item.URI, Error: "decode inline bytes: " + err.Error()})
			return nil, failures
		}
		if len(decoded) == 0 {
			failures = append(failures, failureDetail{URI: item.URI, Error: "inline bytes empty"})
			return nil, failures
		}
		if len(decoded) > maxInlinePayloadBytes {
			failures = append(failures, failureDetail{URI: item.URI, Error: "inline payload exceeds 25MB"})
			return nil, failures
		}
		return decoded, nil
	}
	if strings.HasPrefix(item.URI, "C:\\") || strings.HasPrefix(item.URI, "/") || strings.HasPrefix(item.URI, "\\\\") {
		bytes, err := os.ReadFile(item.URI)
		if err != nil {
			failures = append(failures, failureDetail{URI: item.URI, Error: err.Error()})
			log.Printf("/sync read failure uri=%s err=%v", item.URI, err)
			return nil, failures
		}
		if len(bytes) == 0 {
			failures = append(failures, failureDetail{URI: item.URI, Error: "file empty"})
			log.Printf("/sync read failure uri=%s err=file empty", item.URI)
			return nil, failures
		}
		if len(bytes) > maxInlinePayloadBytes {
			failures = append(failures, failureDetail{URI: item.URI, Error: "inline payload exceeds 25MB"})
			log.Printf("/sync inline bytes too large uri=%s size=%d", item.URI, len(bytes))
			return nil, failures
		}
		return bytes, nil
	}
	return nil, nil
}

func processSyncItem(ctx context.Context, database *db.Database, item MediaUpsert) itemResult {
	res := itemResult{}
	if item.UserID == "" || item.URI == "" || item.Modality == "" {
		return res
	}
	userUUID, ok := resolveUserID(ctx, database, item.UserID)
	if !ok {
		return res
	}
	mediaID, inserted, err := upsertMedia(ctx, database, userUUID, item)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			if pgErr.Code == "23505" {
				if err := database.Pool.QueryRow(ctx, `SELECT id FROM media WHERE user_id=$1 AND uri=$2`, userUUID, item.URI).Scan(&mediaID); err != nil {
					log.Printf("media select after conflict failed uri=%s err=%v", item.URI, err)
					return res
				}
			} else {
				log.Printf("media upsert error uri=%s err=%v", item.URI, err)
			}
		} else {
			log.Printf("media upsert error uri=%s err=%v", item.URI, err)
		}
		return res
	}
	if inserted {
		res.upserted = 1
	}
	lower := strings.ToLower(item.Modality)
	if lower != "image" && lower != "pdf_page" {
		return res
	}
	inline, readFailures := resolveInlineBytes(item)
	if len(readFailures) > 0 {
		res.readFailures = append(res.readFailures, readFailures...)
	}
	if len(inline) == 0 {
		return res
	}
	res.requested = 1
	if err := embed.EnqueueImage(mediaID, item.URI, inline); err != nil {
		res.embedFailures = append(res.embedFailures, failureDetail{URI: item.URI, Error: err.Error()})
		log.Printf("/sync enqueue failed uri=%s err=%v", item.URI, err)
		return res
	}
	res.queued = 1
	log.Printf("/sync enqueued uri=%s media_id=%s queue_depth=%d", item.URI, mediaID, embed.QueueDepth())
	return res
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

	syncVersionOnce.Do(func() { log.Printf("/sync handler revision=4 (stream-ready upserts)") })

	ctx := context.Background()
	stats := syncAccumulator{}

	for _, item := range req.Items {
		stats.apply(processSyncItem(ctx, database, item))
	}

	embedStatus := embed.HealthSnapshot()
	queueDepth := embed.QueueDepth()
	log.Printf(
		"/sync summary items=%d requested=%d queued=%d read_failures=%d embed_failures=%d queue_depth=%d embedder_healthy=%v last_success=%s last_error=%s",
		len(req.Items),
		stats.requested,
		stats.queued,
		len(stats.readFailures),
		len(stats.embedFailures),
		queueDepth,
		embedStatus.Healthy,
		embedStatus.LastSuccess.Format(time.RFC3339),
		embedStatus.LastError,
	)

	embeddedFailed := stats.requested - stats.queued
	if embeddedFailed < 0 {
		embeddedFailed = 0
	}

	return c.JSON(fiber.Map{
		"upserted":          stats.upserted,
		"embedded_images":   stats.queued,
		"embedded_success":  stats.queued,
		"embedded_failed":   embeddedFailed,
		"embed_errors":      stats.embedFailures,
		"read_errors":       stats.readFailures,
		"requested_embeds":  stats.requested,
		"queued_embeds":     stats.queued,
		"embed_queue_depth": queueDepth,
		"embedder_status":   embedStatus,
	})
}

func PostSyncStream(c *fiber.Ctx) error {
	database, ok := c.Locals("db").(*db.Database)
	if !ok || database == nil {
		return fiber.NewError(fiber.StatusInternalServerError, "db missing")
	}

	ctx := context.Background()
	stats := syncAccumulator{}

	reader := c.Context().RequestBodyStream()
	if reader == nil {
		reader = bytes.NewReader(c.Body())
	}

	scanner := bufio.NewScanner(reader)
	buffer := make([]byte, 1024*1024)
	scanner.Buffer(buffer, 32*1024*1024)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var item MediaUpsert
		if err := json.Unmarshal([]byte(line), &item); err != nil {
			log.Printf("/sync/stream decode error: %v", err)
			continue
		}
		stats.apply(processSyncItem(ctx, database, item))
	}

	if err := scanner.Err(); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "stream read error: "+err.Error())
	}

	embedStatus := embed.HealthSnapshot()
	queueDepth := embed.QueueDepth()
	log.Printf(
		"/sync stream summary requested=%d queued=%d read_failures=%d embed_failures=%d queue_depth=%d embedder_healthy=%v last_success=%s last_error=%s",
		stats.requested,
		stats.queued,
		len(stats.readFailures),
		len(stats.embedFailures),
		queueDepth,
		embedStatus.Healthy,
		embedStatus.LastSuccess.Format(time.RFC3339),
		embedStatus.LastError,
	)

	embeddedFailed := stats.requested - stats.queued
	if embeddedFailed < 0 {
		embeddedFailed = 0
	}

	return c.JSON(fiber.Map{
		"upserted":          stats.upserted,
		"embedded_images":   stats.queued,
		"embedded_success":  stats.queued,
		"embedded_failed":   embeddedFailed,
		"embed_errors":      stats.embedFailures,
		"read_errors":       stats.readFailures,
		"requested_embeds":  stats.requested,
		"queued_embeds":     stats.queued,
		"embed_queue_depth": queueDepth,
		"embedder_status":   embedStatus,
	})
}
