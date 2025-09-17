package handlers

import (
	"context"
	"fmt"
	"github.com/TAURAAI/taura/api-gateway/internal/db"
	"github.com/TAURAAI/taura/api-gateway/internal/embed"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"log"
	"math"
	"strings"
	"time"
)

type SearchRequest struct {
	UserID  string                 `json:"user_id"`
	Text    string                 `json:"text"`
	TopK    int                    `json:"top_k"`
	Filters map[string]interface{} `json:"filters"`
}

type SearchResult struct {
	MediaID  string   `json:"media_id"`
	Score    float32  `json:"score"`
	ThumbURL string   `json:"thumb_url"`
	URI      string   `json:"uri"`
	TS       string   `json:"ts"`
	Lat      *float64 `json:"lat"`
	Lon      *float64 `json:"lon"`
	Modality string   `json:"modality"`
}

type SearchResponse struct {
	Results []SearchResult `json:"results"`
}

func PostSearch(c *fiber.Ctx) error {
	var req SearchRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	if req.TopK <= 0 {
		req.TopK = 10
	}
	if req.TopK > 200 {
		req.TopK = 200
	}
	if req.Text == "" {
		return c.JSON(SearchResponse{Results: []SearchResult{}})
	}

	ctx := context.Background()

	start := time.Now()
	vec, err := embed.Text(ctx, req.Text)
	if err != nil {
		log.Printf("embedder text error text='%s' err=%v", truncate(req.Text, 80), err)
		return fiber.NewError(fiber.StatusBadGateway, "embedder error")
	}
	dur := time.Since(start)
	if dur > 150*time.Millisecond {
		log.Printf("embedder latency warn ms=%d", dur.Milliseconds())
	}

	database, ok := c.Locals("db").(*db.Database)
	if !ok || database == nil {
		return fiber.NewError(fiber.StatusInternalServerError, "db missing")
	}
	if len(vec) == 0 {
		return fiber.NewError(fiber.StatusInternalServerError, "empty embedding")
	}

	userID := strings.TrimSpace(req.UserID)
	if userID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "user_id required")
	}
	if _, err := uuid.Parse(userID); err != nil {
		var resolved string
		errLookup := database.Pool.QueryRow(ctx, `SELECT id FROM users WHERE email=$1 LIMIT 1`, userID).Scan(&resolved)
		if errLookup != nil {
			log.Printf("search user resolve failed user=%s err=%v", userID, errLookup)
			return c.JSON(SearchResponse{Results: []SearchResult{}})
		}
		userID = resolved
	}

	filters := req.Filters
	if filters == nil {
		filters = map[string]interface{}{}
	}

	parts := make([]string, len(vec))
	for i, f := range vec {
		parts[i] = fmt.Sprintf("%.6f", f)
	}
	vectorLiteral := "[" + strings.Join(parts, ",") + "]"

	params := []interface{}{vectorLiteral, userID}
	paramIdx := len(params) + 1
	var clause strings.Builder

	if raw, ok := filters["modality"]; ok {
		var modalities []string
		switch v := raw.(type) {
		case []interface{}:
			for _, m := range v {
				if ms, ok := m.(string); ok {
					modalities = append(modalities, ms)
				}
			}
		case []string:
			modalities = v
		}
		if len(modalities) > 0 {
			ph := make([]string, len(modalities))
			for i, m := range modalities {
				ph[i] = fmt.Sprintf("$%d", paramIdx)
				params = append(params, m)
				paramIdx++
			}
			clause.WriteString(" AND m.modality IN (")
			clause.WriteString(strings.Join(ph, ","))
			clause.WriteString(")")
		}
	}

	var timeStart, timeEnd *time.Time
	if trRaw, ok := filters["time_range"]; ok {
		if arr, ok := trRaw.([]interface{}); ok && len(arr) == 2 {
			if s, ok := arr[0].(string); ok && s != "" {
				if t, err := time.Parse(time.RFC3339, s); err == nil {
					timeStart = &t
				}
			}
			if s, ok := arr[1].(string); ok && s != "" {
				if t, err := time.Parse(time.RFC3339, s); err == nil {
					timeEnd = &t
				}
			}
		}
	}
	if timeStart != nil {
		clause.WriteString(fmt.Sprintf(" AND (m.ts IS NOT NULL AND m.ts >= $%d)", paramIdx))
		params = append(params, *timeStart)
		paramIdx++
	}
	if timeEnd != nil {
		clause.WriteString(fmt.Sprintf(" AND (m.ts IS NOT NULL AND m.ts <= $%d)", paramIdx))
		params = append(params, *timeEnd)
		paramIdx++
	}

	if albRaw, ok := filters["album"]; ok {
		var albums []string
		switch v := albRaw.(type) {
		case string:
			albums = []string{v}
		case []interface{}:
			for _, a := range v {
				if as, ok := a.(string); ok {
					albums = append(albums, as)
				}
			}
		}
		if len(albums) > 0 {
			ph := make([]string, len(albums))
			for i, a := range albums {
				ph[i] = fmt.Sprintf("$%d", paramIdx)
				params = append(params, a)
				paramIdx++
			}
			clause.WriteString(" AND m.album IN (")
			clause.WriteString(strings.Join(ph, ","))
			clause.WriteString(")")
		}
	}

	if geoRaw, ok := filters["geo"]; ok {
		if gmap, ok := geoRaw.(map[string]interface{}); ok {
			latRaw, lok1 := gmap["lat"].(float64)
			lonRaw, lok2 := gmap["lon"].(float64)
			rawKm, lok3 := gmap["km"].(float64)
			if lok1 && lok2 && lok3 && rawKm > 0 {
				dLat := rawKm / 111.0
				dLon := rawKm / (111.0 * math.Cos(latRaw*math.Pi/180.0))
				minLat, maxLat := latRaw-dLat, latRaw+dLat
				minLon, maxLon := lonRaw-dLon, lonRaw+dLon
				clause.WriteString(fmt.Sprintf(" AND m.lat BETWEEN $%d AND $%d AND m.lon BETWEEN $%d AND $%d", paramIdx, paramIdx+1, paramIdx+2, paramIdx+3))
				params = append(params, minLat, maxLat, minLon, maxLon)
				paramIdx += 4
			}
		}
	}

	params = append(params, req.TopK)
	limitIdx := len(params)
	sql := fmt.Sprintf(`SELECT m.id, 1 - (v.embedding <=> $1::vector) AS score, COALESCE(m.thumb_url,''), m.uri, COALESCE(to_char(m.ts,'YYYY-MM-DD"T"HH24:MI:SSZ'),''), m.lat, m.lon, m.modality
		FROM media_vecs v
		JOIN media m ON m.id = v.media_id
		WHERE m.user_id = $2 AND m.deleted = false%s
		ORDER BY v.embedding <=> $1::vector ASC
		LIMIT $%d`, clause.String(), limitIdx)

	rows, err := database.Pool.Query(ctx, sql, params...)
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

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
