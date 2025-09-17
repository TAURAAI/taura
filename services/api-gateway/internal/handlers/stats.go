package handlers

import (
	"context"
	"database/sql"
	"github.com/TAURAAI/taura/api-gateway/internal/db"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"log"
	"strings"
	"time"
)

type StatsResponse struct {
	UserID        string  `json:"user_id"`
	MediaCount    int64   `json:"media_count"`
	EmbeddedCount int64   `json:"embedded_count"`
	LastIndexedAt *string `json:"last_indexed_at"`
}

func GetStats(c *fiber.Ctx) error {
	database, ok := c.Locals("db").(*db.Database)
	if !ok || database == nil {
		return fiber.NewError(fiber.StatusInternalServerError, "db missing")
	}

	userID := strings.TrimSpace(c.Query("user_id"))
	if userID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "user_id required")
	}

	ctx := context.Background()
	original := userID
	if _, err := uuid.Parse(userID); err != nil {
		var resolved string
		if err := database.Pool.QueryRow(ctx, `SELECT id FROM users WHERE email=$1 LIMIT 1`, userID).Scan(&resolved); err != nil {
			if err == sql.ErrNoRows {
				return fiber.NewError(fiber.StatusNotFound, "user not found")
			}
			log.Printf("stats user resolve failed user=%s err=%v", userID, err)
			return fiber.NewError(fiber.StatusInternalServerError, "user lookup failed")
		}
		userID = resolved
	}

	var mediaCount int64
	if err := database.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM media WHERE user_id=$1 AND deleted=false`, userID).Scan(&mediaCount); err != nil {
		log.Printf("stats media count error user=%s err=%v", userID, err)
		return fiber.NewError(fiber.StatusInternalServerError, "media count error")
	}

	var embeddedCount int64
	if err := database.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM media_vecs mv JOIN media m ON m.id = mv.media_id WHERE m.user_id=$1 AND m.deleted=false`, userID).Scan(&embeddedCount); err != nil {
		log.Printf("stats embedded count error user=%s err=%v", userID, err)
		return fiber.NewError(fiber.StatusInternalServerError, "embedded count error")
	}

	var latest sql.NullTime
	if err := database.Pool.QueryRow(ctx, `SELECT MAX(m.ts) FROM media m WHERE m.user_id=$1 AND m.deleted=false`, userID).Scan(&latest); err != nil {
		log.Printf("stats last indexed error user=%s err=%v", userID, err)
	}

	var lastIndexed *string
	if latest.Valid {
		formatted := latest.Time.UTC().Format(time.RFC3339)
		lastIndexed = &formatted
	}

	return c.JSON(StatsResponse{
		UserID:        original,
		MediaCount:    mediaCount,
		EmbeddedCount: embeddedCount,
		LastIndexedAt: lastIndexed,
	})
}
