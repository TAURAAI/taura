package handlers

import (
	"context"
	"github.com/gofiber/fiber/v2"
	"github.com/TAURAAI/taura/api-gateway/internal/embed"
	"github.com/TAURAAI/taura/api-gateway/internal/db"
	"log"
	"fmt"
	"strings"
)

type SearchRequest struct {
	UserID  string                 `json:"user_id"`
	Text    string                 `json:"text"`
	TopK    int                    `json:"top_k"`
	Filters map[string]interface{} `json:"filters"`
}

type SearchResult struct {
	MediaID  string  `json:"media_id"`
	Score    float32 `json:"score"`
	ThumbURL string  `json:"thumb_url"`
	URI      string  `json:"uri"`
	TS       string  `json:"ts"`
	Lat      *float64 `json:"lat"`
	Lon      *float64 `json:"lon"`
	Modality string  `json:"modality"`
}

type SearchResponse struct {
	Results []SearchResult `json:"results"`
}

func PostSearch(c *fiber.Ctx) error {
	var req SearchRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	if req.TopK == 0 {
		req.TopK = 10
	}
	if req.Text == "" { return c.JSON(SearchResponse{Results: []SearchResult{}}) }

	vec, err := embed.Text(context.Background(), req.Text)
	if err != nil {
		return fiber.NewError(fiber.StatusBadGateway, "embedder error")
	}

	database, ok := c.Locals("db").(*db.Database)
	if !ok || database == nil { return fiber.NewError(fiber.StatusInternalServerError, "db missing") }
	if len(vec) == 0 { return fiber.NewError(fiber.StatusInternalServerError, "empty embedding") }

		modalityClause := ""
		var modalities []string
		if raw, ok := req.Filters["modality"]; ok {
			switch v := raw.(type) {
			case []interface{}:
				for _, m := range v { if ms, ok := m.(string); ok { modalities = append(modalities, ms) } }
			case []string:
				modalities = v
			}
		}
		if len(modalities) > 0 {
			quoted := make([]string, 0, len(modalities))
			for _, m := range modalities { quoted = append(quoted, fmt.Sprintf("'%s'", strings.ReplaceAll(m, "'", "''"))) }
			modalityClause = " AND m.modality IN (" + strings.Join(quoted, ",") + ")"
		}

		parts := make([]string, len(vec))
		for i, f := range vec { parts[i] = fmt.Sprintf("%.6f", f) }
		vectorLiteral := "[" + strings.Join(parts, ",") + "]"

		sql := fmt.Sprintf(`SELECT m.id, 1 - (v.embedding <=> $1::vector) AS score, COALESCE(m.thumb_url,''), m.uri, COALESCE(to_char(m.ts,'YYYY-MM-DD"T"HH24:MI:SSZ'),''), m.lat, m.lon, m.modality
			FROM media_vecs v
			JOIN media m ON m.id = v.media_id
			WHERE m.user_id = $2 AND m.deleted = false%s
			ORDER BY v.embedding <=> $1::vector ASC
			LIMIT %d`, modalityClause, req.TopK)

		rows, err := database.Pool.Query(context.Background(), sql, vectorLiteral, req.UserID)
		if err != nil {
			log.Printf("search query error: %v", err)
			return fiber.NewError(fiber.StatusInternalServerError, "query error")
		}
		defer rows.Close()
		results := make([]SearchResult, 0, req.TopK)
		for rows.Next() {
			var r SearchResult
			if err := rows.Scan(&r.MediaID, &r.Score, &r.ThumbURL, &r.URI, &r.TS, &r.Lat, &r.Lon, &r.Modality); err != nil {
				log.Printf("scan error: %v", err)
				continue
			}
			results = append(results, r)
		}
		return c.JSON(SearchResponse{Results: results})
}
