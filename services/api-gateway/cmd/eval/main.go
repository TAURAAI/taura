package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

type querySpec struct {
	Text     string         `json:"text"`
	Expected []string       `json:"expected"`
	Filters  map[string]any `json:"filters,omitempty"`
	TopK     int            `json:"top_k,omitempty"`
}

type dataset struct {
	Description string      `json:"description"`
	Queries     []querySpec `json:"queries"`
}

type searchResult struct {
	MediaID string  `json:"media_id"`
	URI     string  `json:"uri"`
	Score   float32 `json:"score"`
}

type searchResponse struct {
	Results []searchResult `json:"results"`
}

type evaluation struct {
	server  string
	user    string
	client  *http.Client
	dataset dataset
	topK    int
	verbose bool
	timeout time.Duration
}

func main() {
	datasetPath := flag.String("dataset", "", "Path to evaluation dataset JSON")
	server := flag.String("server", "http://localhost:8080", "API gateway base URL")
	user := flag.String("user", "user", "User ID / email for search requests")
	topK := flag.Int("topk", 12, "Default top_k if not specified per query")
	verbose := flag.Bool("verbose", false, "Print per-query debug details")
	timeout := flag.Duration("timeout", 15*time.Second, "HTTP timeout per request")
	flag.Parse()

	if *datasetPath == "" {
		fmt.Fprintln(os.Stderr, "--dataset is required")
		os.Exit(1)
	}

	dsFile, err := os.Open(*datasetPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to open dataset: %v\n", err)
		os.Exit(1)
	}
	defer dsFile.Close()

	var ds dataset
	if err := json.NewDecoder(dsFile).Decode(&ds); err != nil {
		fmt.Fprintf(os.Stderr, "failed to parse dataset: %v\n", err)
		os.Exit(1)
	}

	if len(ds.Queries) == 0 {
		fmt.Fprintln(os.Stderr, "dataset contains no queries")
		os.Exit(1)
	}

	ev := evaluation{
		server:  strings.TrimRight(*server, "/"),
		user:    *user,
		client:  &http.Client{Timeout: *timeout},
		dataset: ds,
		topK:    *topK,
		verbose: *verbose,
		timeout: *timeout,
	}

	stats, err := ev.run(context.Background())
	if err != nil {
		fmt.Fprintf(os.Stderr, "evaluation failed: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("Taura Retrieval Evaluation")
	if ev.dataset.Description != "" {
		fmt.Printf("Dataset: %s\n", ev.dataset.Description)
	}
	fmt.Printf("Queries: %d\n", len(ev.dataset.Queries))
	fmt.Printf("Server: %s\n", ev.server)
	fmt.Printf("User: %s\n\n", ev.user)

	fmt.Printf("Hit Rate (>=1 match): %.2f%%\n", stats.hitRate*100)
	fmt.Printf("Recall@K (per-query avg): %.2f%%\n", stats.recallAtK*100)
	fmt.Printf("MRR: %.3f\n", stats.mrr)
	fmt.Printf("Avg Latency: %.2f ms\n", stats.avgLatency)
	fmt.Printf("p95 Latency: %.2f ms\n", stats.p95Latency)
}

type evaluationStats struct {
	hitRate    float64
	recallAtK  float64
	mrr        float64
	avgLatency float64
	p95Latency float64
}

func (e *evaluation) run(ctx context.Context) (evaluationStats, error) {
	totalQueries := len(e.dataset.Queries)
	if totalQueries == 0 {
		return evaluationStats{}, fmt.Errorf("no queries to evaluate")
	}

	hits := 0
	recallSum := 0.0
	mrrSum := 0.0
	latencies := make([]float64, 0, totalQueries)

	for _, q := range e.dataset.Queries {
		k := q.TopK
		if k <= 0 {
			k = e.topK
		}
		start := time.Now()
		resp, err := e.callSearch(ctx, q.Text, k, q.Filters)
		duration := time.Since(start).Seconds() * 1000
		latencies = append(latencies, duration)
		if err != nil {
			if e.verbose {
				fmt.Fprintf(os.Stderr, "query error: %s -> %v\n", q.Text, err)
			}
			continue
		}

		expectedCount := len(q.Expected)
		if expectedCount == 0 {
			continue
		}

		found := 0
		bestRank := -1
		for idx, item := range resp.Results {
			for _, exp := range q.Expected {
				if strings.EqualFold(strings.TrimSpace(item.URI), strings.TrimSpace(exp)) {
					found++
					if bestRank == -1 || idx < bestRank {
						bestRank = idx
					}
				}
			}
		}

		if found > 0 {
			hits++
		}

		recallSum += float64(found) / float64(expectedCount)
		if bestRank >= 0 {
			mrrSum += 1.0 / float64(bestRank+1)
		}

		if e.verbose {
			fmt.Printf("%s\n", q.Text)
			fmt.Printf("  latency: %.2f ms | hits: %d/%d\n", duration, found, expectedCount)
			if found == 0 {
				fmt.Println("  expected URIs not found")
			} else {
				fmt.Printf("  best rank: %d\n", bestRank+1)
			}
		}
	}

	// compute aggregates
	hitRate := float64(hits) / float64(totalQueries)
	recallAtK := recallSum / float64(totalQueries)
	mrr := mrrSum / float64(totalQueries)
	avgLatency := average(latencies)
	p95Latency := percentile(latencies, 0.95)

	return evaluationStats{
		hitRate:    hitRate,
		recallAtK:  recallAtK,
		mrr:        mrr,
		avgLatency: avgLatency,
		p95Latency: p95Latency,
	}, nil
}

func (e *evaluation) callSearch(ctx context.Context, text string, topK int, filters map[string]any) (*searchResponse, error) {
	payload := map[string]any{
		"user_id": e.user,
		"text":    text,
		"top_k":   topK,
	}
	if len(filters) > 0 {
		payload["filters"] = filters
	}
	buf, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.server+"/search", bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := e.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return nil, fmt.Errorf("gateway returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var decoded searchResponse
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return nil, err
	}
	return &decoded, nil
}

func average(vals []float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	sum := 0.0
	for _, v := range vals {
		sum += v
	}
	return sum / float64(len(vals))
}

func percentile(vals []float64, p float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	sorted := append([]float64(nil), vals...)
	sort.Float64s(sorted)
	rank := p * float64(len(sorted)-1)
	lo := int(rank)
	hi := lo + 1
	if hi >= len(sorted) {
		return sorted[len(sorted)-1]
	}
	frac := rank - float64(lo)
	return sorted[lo] + frac*(sorted[hi]-sorted[lo])
}
