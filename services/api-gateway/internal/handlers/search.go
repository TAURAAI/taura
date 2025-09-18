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
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
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
	Album    *string  `json:"album,omitempty"`
	Source   *string  `json:"source,omitempty"`
}

type SearchResponse struct {
	Results []SearchResult `json:"results"`
}

func PostSearch(c *fiber.Ctx) error {
	var req SearchRequest
	if err := c.BodyParser(&req); err != nil {
		log.Printf("[SEARCH] Failed to parse request body: %v", err)
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}

	// Log the incoming search request
	log.Printf("[SEARCH] Incoming request - user_id=%s, text='%s', top_k=%d, filters=%v",
		req.UserID, truncate(req.Text, 80), req.TopK, req.Filters)

	if req.TopK <= 0 {
		req.TopK = 10
	}
	if req.TopK > 200 {
		req.TopK = 200
	}
	if req.Text == "" {
		log.Printf("[SEARCH] Empty search text, returning empty results")
		return c.JSON(SearchResponse{Results: []SearchResult{}})
	}

	ctx := context.Background()
	searchStart := time.Now()

	// Text embedding with detailed logging
	log.Printf("[SEARCH] Starting text embedding - text_length=%d", len(req.Text))
	start := time.Now()
	vec, err := embed.Text(ctx, req.Text)
	if err != nil {
		log.Printf("[SEARCH] Embedder text error - text='%s', error=%v, elapsed=%dms",
			truncate(req.Text, 80), err, time.Since(start).Milliseconds())
		return fiber.NewError(fiber.StatusBadGateway, "embedder error")
	}
	embedDur := time.Since(start)
	log.Printf("[SEARCH] Text embedding completed - dim=%d, elapsed=%dms, norm=%.6f",
		len(vec), embedDur.Milliseconds(), vectorNorm(vec))

	if embedDur > 150*time.Millisecond {
		log.Printf("[SEARCH] Embedder latency warning - elapsed=%dms (>150ms)", embedDur.Milliseconds())
	}

	database, ok := c.Locals("db").(*db.Database)
	if !ok || database == nil {
		log.Printf("[SEARCH] Database connection missing")
		return fiber.NewError(fiber.StatusInternalServerError, "db missing")
	}
	if len(vec) == 0 {
		log.Printf("[SEARCH] Empty embedding received from embedder")
		return fiber.NewError(fiber.StatusInternalServerError, "empty embedding")
	}

	// User ID resolution with logging
	userID := strings.TrimSpace(req.UserID)
	if userID == "" {
		log.Printf("[SEARCH] Missing user_id in request")
		return fiber.NewError(fiber.StatusBadRequest, "user_id required")
	}
	originalUserID := userID
	if _, err := uuid.Parse(userID); err != nil {
		log.Printf("[SEARCH] Resolving user email to UUID - email=%s", userID)
		var resolved string
		errLookup := database.Pool.QueryRow(ctx, `SELECT id FROM users WHERE email=$1 LIMIT 1`, userID).Scan(&resolved)
		if errLookup != nil {
			log.Printf("[SEARCH] User resolution failed - email=%s, error=%v", userID, errLookup)
			return c.JSON(SearchResponse{Results: []SearchResult{}})
		}
		userID = resolved
		log.Printf("[SEARCH] User resolved - email=%s -> uuid=%s", originalUserID, userID)
	}

	// Filter processing with logging
	filters := req.Filters
	if filters == nil {
		filters = map[string]interface{}{}
	}
	log.Printf("[SEARCH] Processing filters - count=%d, filters=%v", len(filters), filters)

	// Build vector search query
	parts := make([]string, len(vec))
	for i, f := range vec {
		parts[i] = fmt.Sprintf("%.9f", f)
	}
	vectorLiteral := "[" + strings.Join(parts, ",") + "]"

	params := []interface{}{vectorLiteral, userID}
	paramIdx := len(params) + 1
	var clause strings.Builder
	filtersApplied := 0

	// Process modality filter
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
			filtersApplied++
			log.Printf("[SEARCH] Applied modality filter - modalities=%v", modalities)
		}
	}

	// Process time range filter
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
		filtersApplied++
		log.Printf("[SEARCH] Applied time start filter - start=%s", timeStart.Format(time.RFC3339))
	}
	if timeEnd != nil {
		clause.WriteString(fmt.Sprintf(" AND (m.ts IS NOT NULL AND m.ts <= $%d)", paramIdx))
		params = append(params, *timeEnd)
		paramIdx++
		filtersApplied++
		log.Printf("[SEARCH] Applied time end filter - end=%s", timeEnd.Format(time.RFC3339))
	}

	// Process album filter
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
			filtersApplied++
			log.Printf("[SEARCH] Applied album filter - albums=%v", albums)
		}
	}

	// Process geo filter
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
				filtersApplied++
				log.Printf("[SEARCH] Applied geo filter - lat=%.4f, lon=%.4f, radius=%.1fkm", latRaw, lonRaw, rawKm)
			}
		}
	}

	// Vector search execution
	annLimit := req.TopK * 6
	if annLimit < 80 {
		annLimit = 80
	}
	if annLimit > 400 {
		annLimit = 400
	}
	if annLimit < req.TopK {
		annLimit = req.TopK
	}
	params = append(params, annLimit)
	limitIdx := len(params)

	sql := fmt.Sprintf(`SELECT m.id, 1 - (v.embedding <=> $1::vector) AS score, COALESCE(m.thumb_url,''), m.uri, COALESCE(to_char(m.ts,'YYYY-MM-DD"T"HH24:MI:SSZ'),''), m.lat, m.lon, m.modality, m.album, m.source
		FROM media_vecs v
		JOIN media m ON m.id = v.media_id
		WHERE m.user_id = $2 AND m.deleted = false%s
		ORDER BY v.embedding <=> $1::vector ASC
		LIMIT $%d`, clause.String(), limitIdx)

	log.Printf("[SEARCH] Executing vector search - user=%s, ann_limit=%d, filters_applied=%d", userID, annLimit, filtersApplied)
	queryStart := time.Now()
	rows, err := database.Pool.Query(ctx, sql, params...)
	if err != nil {
		log.Printf("[SEARCH] Vector search query failed - error=%v, elapsed=%dms", err, time.Since(queryStart).Milliseconds())
		return fiber.NewError(fiber.StatusInternalServerError, "query error")
	}
	defer rows.Close()

	results := make([]SearchResult, 0, annLimit)
	var bestScore float32
	resultCount := 0
	for rows.Next() {
		var r SearchResult
		if err := rows.Scan(&r.MediaID, &r.Score, &r.ThumbURL, &r.URI, &r.TS, &r.Lat, &r.Lon, &r.Modality, &r.Album, &r.Source); err != nil {
			log.Printf("[SEARCH] Row scan error: %v", err)
			continue
		}
		if len(results) == 0 || r.Score > bestScore {
			bestScore = r.Score
		}
		results = append(results, r)
		resultCount++
	}
	queryDur := time.Since(queryStart)
	log.Printf("[SEARCH] Vector search completed - results=%d, best_score=%.4f, elapsed=%dms", resultCount, bestScore, queryDur.Milliseconds())

	// Reranking with logging
	keywords := tokenizeQuery(req.Text)
	log.Printf("[SEARCH] Starting rerank - keywords=%v, initial_results=%d", keywords, len(results))
	rerankStart := time.Now()
	results = rerankResults(results, keywords, req.TopK)
	rerankDur := time.Since(rerankStart)
	log.Printf("[SEARCH] Rerank completed - final_results=%d, elapsed=%dms", len(results), rerankDur.Milliseconds())

	// Keyword fallback logic
	if len(results) == 0 || bestScore < 0.2 {
		log.Printf("[SEARCH] Triggering keyword fallback - results=%d, best_score=%.4f", len(results), bestScore)
		fallbackStart := time.Now()
		if fb, err := keywordFallback(ctx, database, userID, keywords, req.TopK); err != nil {
			log.Printf("[SEARCH] Keyword fallback failed - error=%v, elapsed=%dms", err, time.Since(fallbackStart).Milliseconds())
		} else if len(fb) > 0 {
			log.Printf("[SEARCH] Keyword fallback succeeded - fallback_results=%d, elapsed=%dms", len(fb), time.Since(fallbackStart).Milliseconds())
			results = rerankResults(fb, keywords, req.TopK)
			log.Printf("[SEARCH] Fallback rerank completed - final_results=%d", len(results))
		} else {
			log.Printf("[SEARCH] Keyword fallback returned no results - elapsed=%dms", time.Since(fallbackStart).Milliseconds())
		}
	}

	totalDur := time.Since(searchStart)
	log.Printf("[SEARCH] Search completed - user=%s, text='%s', final_results=%d, total_elapsed=%dms",
		originalUserID, truncate(req.Text, 80), len(results), totalDur.Milliseconds())

	return c.JSON(SearchResponse{Results: results})
}

func rerankResults(base []SearchResult, keywords []string, topK int) []SearchResult {
	if len(base) == 0 {
		return base
	}
	kwCount := len(keywords)
	log.Printf("[RERANK] Starting rerank - input_count=%d, keywords=%d, topK=%d", len(base), kwCount, topK)
	years, months := parseTemporalHints(keywords)
	if len(years) > 0 || len(months) > 0 {
		log.Printf("[RERANK] Temporal hints detected - years=%v, months=%v", years, months)
	}

	if kwCount == 0 && len(base) <= topK {
		log.Printf("[RERANK] No keywords and results fit limit, returning as-is")
		return base
	}

	bonusCount := 0
	for i := range base {
		originalScore := base[i].Score
		bonus := float32(0)
		if kwCount > 0 {
			metaBuilder := strings.Builder{}
			metaBuilder.Grow(len(base[i].URI) + 64)
			metaBuilder.WriteString(strings.ToLower(base[i].URI))
			metaBuilder.WriteByte(' ')
			metaBuilder.WriteString(strings.ToLower(base[i].Modality))
			if base[i].Album != nil {
				metaBuilder.WriteByte(' ')
				metaBuilder.WriteString(strings.ToLower(*base[i].Album))
			}
			if base[i].Source != nil {
				metaBuilder.WriteByte(' ')
				metaBuilder.WriteString(strings.ToLower(*base[i].Source))
			}
			meta := metaBuilder.String()
			matches := 0
			for _, kw := range keywords {
				if kw == "" {
					continue
				}
				if strings.Contains(meta, kw) {
					matches++
				}
			}
			if matches > 0 {
				bonus += float32(matches) * 0.03
				if bonus > 0.15 {
					bonus = 0.15
				}
				bonusCount++
			}
		}
		if len(years) > 0 || len(months) > 0 {
			tScore := float32(0)
			if base[i].TS != "" {
				if parsed, err := time.Parse(time.RFC3339, base[i].TS); err == nil {
					if len(years) > 0 {
						for _, y := range years {
							if parsed.Year() == y {
								tScore += 0.06
								break
							}
						}
					}
					if len(months) > 0 {
						for _, m := range months {
							if parsed.Month() == m {
								tScore += 0.04
								break
							}
						}
					}
				}
			}
			if base[i].Album != nil && len(years) > 0 {
				lowerAlbum := strings.ToLower(*base[i].Album)
				for _, y := range years {
					if strings.Contains(lowerAlbum, fmt.Sprintf("%d", y)) {
						tScore += 0.02
						break
					}
				}
			}
			if tScore > 0 {
				bonus += tScore
				log.Printf("[RERANK] Item %d temporal boost - uri='%s', boost=%.4f", i, truncate(base[i].URI, 50), tScore)
			}
		}
		scored := base[i].Score + bonus
		if scored > 1.0 {
			scored = 1.0
		}
		base[i].Score = scored

		if bonus > 0 {
			log.Printf("[RERANK] Item %d keyword bonus - uri='%s', original_score=%.4f, bonus=%.4f, final_score=%.4f",
				i, truncate(base[i].URI, 50), originalScore, bonus, scored)
		}
	}

	log.Printf("[RERANK] Applied keyword bonuses to %d/%d items", bonusCount, len(base))

	sort.Slice(base, func(i, j int) bool {
		if base[i].Score == base[j].Score {
			return base[i].TS > base[j].TS
		}
		return base[i].Score > base[j].Score
	})

	log.Printf("[RERANK] Sorted results - best_score=%.4f, worst_score=%.4f",
		base[0].Score, base[len(base)-1].Score)

	if topK < len(base) {
		trim := make([]SearchResult, topK)
		copy(trim, base[:topK])
		log.Printf("[RERANK] Trimmed results from %d to %d", len(base), topK)
		return trim
	}
	log.Printf("[RERANK] Returning all %d results", len(base))
	return base
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func vectorNorm(vec []float32) float64 {
	var sum float64
	for _, v := range vec {
		sum += float64(v) * float64(v)
	}
	return math.Sqrt(sum)
}

func tokenizeQuery(q string) []string {
	q = strings.ToLower(q)
	parts := strings.FieldsFunc(q, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsNumber(r) })
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if len(p) >= 2 {
			out = append(out, p)
		}
	}
	return out
}

var monthLookup = map[string]time.Month{
	"jan":       time.January,
	"january":   time.January,
	"feb":       time.February,
	"february":  time.February,
	"mar":       time.March,
	"march":     time.March,
	"apr":       time.April,
	"april":     time.April,
	"may":       time.May,
	"jun":       time.June,
	"june":      time.June,
	"jul":       time.July,
	"july":      time.July,
	"aug":       time.August,
	"august":    time.August,
	"sep":       time.September,
	"sept":      time.September,
	"september": time.September,
	"oct":       time.October,
	"october":   time.October,
	"nov":       time.November,
	"november":  time.November,
	"dec":       time.December,
	"december":  time.December,
}

func parseTemporalHints(tokens []string) ([]int, []time.Month) {
	years := make([]int, 0, 2)
	months := make([]time.Month, 0, 2)
	yearSeen := map[int]struct{}{}
	monthSeen := map[time.Month]struct{}{}
	for _, tok := range tokens {
		if len(tok) == 4 {
			if y, err := strconv.Atoi(tok); err == nil && y >= 1900 && y <= 2100 {
				if _, ok := yearSeen[y]; !ok {
					yearSeen[y] = struct{}{}
					years = append(years, y)
				}
				continue
			}
		}
		if m, ok := monthLookup[tok]; ok {
			if _, seen := monthSeen[m]; !seen {
				monthSeen[m] = struct{}{}
				months = append(months, m)
			}
		}
	}
	return years, months
}

func keywordFallback(ctx context.Context, database *db.Database, userID string, tokens []string, limit int) ([]SearchResult, error) {
	log.Printf("[FALLBACK] Starting keyword fallback - user=%s, tokens=%v, limit=%d", userID, tokens, limit)

	params := []interface{}{userID}
	where := strings.Builder{}
	if len(tokens) > 0 {
		clauses := make([]string, 0, len(tokens))
		for _, tok := range tokens {
			params = append(params, "%"+tok+"%")
			idx := len(params)
			clauses = append(clauses, fmt.Sprintf("(m.uri ILIKE $%d OR COALESCE(m.album,'') ILIKE $%d OR COALESCE(m.source,'') ILIKE $%d)", idx, idx, idx))
		}
		where.WriteString(" AND (")
		where.WriteString(strings.Join(clauses, " OR "))
		where.WriteString(")")
		log.Printf("[FALLBACK] Built keyword clauses - clauses=%d", len(clauses))
	}

	params = append(params, limit)
	sql := fmt.Sprintf(`SELECT m.id, 0.0 AS score, COALESCE(m.thumb_url,''), m.uri,
		COALESCE(to_char(m.ts,'YYYY-MM-DD"T"HH24:MI:SSZ'),''), m.lat, m.lon, m.modality, m.album, m.source
		FROM media m
		WHERE m.user_id=$1 AND m.deleted=false%s
		ORDER BY m.ts DESC NULLS LAST, m.uri ASC
		LIMIT $%d`, where.String(), len(params))

	log.Printf("[FALLBACK] Executing fallback query")
	queryStart := time.Now()
	rows, err := database.Pool.Query(ctx, sql, params...)
	if err != nil {
		log.Printf("[FALLBACK] Query failed - error=%v, elapsed=%dms", err, time.Since(queryStart).Milliseconds())
		return nil, err
	}
	defer rows.Close()

	results := make([]SearchResult, 0, limit)
	for rows.Next() {
		var r SearchResult
		if err := rows.Scan(&r.MediaID, &r.Score, &r.ThumbURL, &r.URI, &r.TS, &r.Lat, &r.Lon, &r.Modality, &r.Album, &r.Source); err != nil {
			log.Printf("[FALLBACK] Scan error: %v", err)
			return nil, err
		}
		results = append(results, r)
	}

	queryDur := time.Since(queryStart)
	log.Printf("[FALLBACK] Fallback completed - results=%d, elapsed=%dms", len(results), queryDur.Milliseconds())
	return results, nil
}
