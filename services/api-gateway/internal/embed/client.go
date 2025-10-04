package embed

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"
)

type textReq struct {
	Text string `json:"text"`
}
type textRes struct {
	Vec []float32 `json:"vec"`
}

type imageReq struct {
	URI         string `json:"uri,omitempty"`
	BytesBase64 string `json:"bytes_b64,omitempty"`
}

type embeddingDiag struct {
	Dim        int      `json:"dim"`
	Norm       float64  `json:"norm"`
	Tiles      *int     `json:"tiles,omitempty"`
	Crops      *int     `json:"crops,omitempty"`
	Scales     *int     `json:"scales,omitempty"`
	PrepMs     *float64 `json:"prep_ms,omitempty"`
	TransferMs *float64 `json:"transfer_ms,omitempty"`
	InferMs    *float64 `json:"infer_ms,omitempty"`
	TotalMs    *float64 `json:"total_ms,omitempty"`
	TokenCount *int     `json:"token_count,omitempty"`
	ContextLen *int     `json:"context_length,omitempty"`
	TokenizeMs *float64 `json:"tokenize_ms,omitempty"`
	Elapsed    *float64 `json:"elapsed,omitempty"`
}

type imageRes struct {
	Vec  []float32      `json:"vec"`
	Diag *embeddingDiag `json:"diag"`
}
type imageBatchReq struct {
	ImagesB64 []string `json:"images_b64"`
}
type imageBatchRes struct {
	Vecs        [][]float32      `json:"vecs"`
	Errors      []*string        `json:"errors"`
	Diagnostics []*embeddingDiag `json:"diagnostics"`
}

type batchTextReq struct {
	Texts []string `json:"texts"`
}
type batchTextRes struct {
	Vecs [][]float32 `json:"vecs"`
}

var httpClient = &http.Client{Timeout: 8 * time.Second}

// configuration defaults (can be overridden via env)
var (
	defaultHTTPTimeoutSeconds = 30
	defaultMaxRetries         = 3
	defaultRetryBackoffMs     = 250
	defaultSplitThreshold     = 8   // if timeout on batch > this, split
	defaultPerImageEstimateMs = 160 // rough per-image latency w/ TTA
)

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

func configureTimeoutFromEnv() {
	httpClient.Timeout = time.Duration(envInt("EMBEDDER_HTTP_TIMEOUT_SECONDS", defaultHTTPTimeoutSeconds)) * time.Second
}

func baseURL() string {
	b := os.Getenv("EMBEDDER_URL")
	if b == "" {
		b = "http://localhost:9000"
	}
	return b
}

func decodeOrError(resp *http.Response, target interface{}) error {
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("embedder status %d: %s", resp.StatusCode, string(body))
	}
	dec := json.NewDecoder(resp.Body)
	return dec.Decode(target)
}

func validateVec(vec []float32, diag *embeddingDiag) error {
	if len(vec) == 0 {
		return errors.New("empty embedding vector")
	}
	for _, v := range vec {
		f := float64(v)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return fmt.Errorf("invalid embedding value: %v", f)
		}
	}

	expectedDim := envInt("EMBEDDER_TARGET_DIM", 0)
	if expectedDim > 0 && len(vec) != expectedDim {
		return fmt.Errorf("embedding dim %d != expected %d", len(vec), expectedDim)
	}

	if diag != nil {
		if diag.Dim > 0 && len(vec) != diag.Dim {
			return fmt.Errorf("embedding dim %d != diag %d", len(vec), diag.Dim)
		}
		if diag.Norm != 0 && (math.IsNaN(diag.Norm) || diag.Norm < 0.5) {
			return fmt.Errorf("embedding norm suspicious: %.6f", diag.Norm)
		}
	} else {
		sumSquares := 0.0
		for _, v := range vec {
			sumSquares += float64(v) * float64(v)
		}
		norm := math.Sqrt(sumSquares)
		if norm < 0.5 {
			return fmt.Errorf("embedding norm suspicious: %.6f", norm)
		}
	}
	return nil
}

func mergeErr(base string, err error) string {
	if err == nil {
		return base
	}
	if base == "" {
		return err.Error()
	}
	return base + "; " + err.Error()
}

func Text(ctx context.Context, text string) ([]float32, error) {
	configureTimeoutFromEnv()
	if text == "" {
		return nil, errors.New("empty text")
	}
	b, _ := json.Marshal(textReq{Text: text})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, baseURL()+"/embed/text", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		noteFailure(err)
		return nil, err
	}
	defer resp.Body.Close()
	var tr textRes
	if err := decodeOrError(resp, &tr); err != nil {
		noteFailure(err)
		return nil, err
	}
	noteSuccess()
	return tr.Vec, nil
}

func TextBatch(ctx context.Context, texts []string) ([][]float32, error) {
	configureTimeoutFromEnv()
	if len(texts) == 0 {
		return nil, errors.New("empty batch")
	}
	b, _ := json.Marshal(batchTextReq{Texts: texts})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, baseURL()+"/embed/text/batch", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		noteFailure(err)
		return nil, err
	}
	defer resp.Body.Close()
	var br batchTextRes
	if err := decodeOrError(resp, &br); err != nil {
		noteFailure(err)
		return nil, err
	}
	noteSuccess()
	return br.Vecs, nil
}

func Image(ctx context.Context, uriOrB64 string, isBase64 bool) ([]float32, error) {
	configureTimeoutFromEnv()
	payload := imageReq{}
	if isBase64 {
		payload.BytesBase64 = uriOrB64
	} else {
		payload.URI = uriOrB64
	}
	b, _ := json.Marshal(payload)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, baseURL()+"/embed/image", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		noteFailure(err)
		return nil, err
	}
	defer resp.Body.Close()
	var ir imageRes
	if err := decodeOrError(resp, &ir); err != nil {
		noteFailure(err)
		return nil, err
	}
	if err := validateVec(ir.Vec, ir.Diag); err != nil {
		noteFailure(err)
		return nil, err
	}
	noteSuccess()
	return ir.Vec, nil
}

// ImageBatch embeds a batch of images with retry, exponential backoff and adaptive splitting.
// On timeout / network errors it will (a) retry up to EMBEDDER_MAX_RETRIES, then (b) if batch > 1
// split into halves and recurse, preserving order.
func ImageBatch(ctx context.Context, imagesB64 [][]byte) ([][]float32, []string, error) {
	configureTimeoutFromEnv()
	if len(imagesB64) == 0 {
		return nil, nil, errors.New("empty image batch")
	}

	maxRetries := envInt("EMBEDDER_MAX_RETRIES", defaultMaxRetries)
	backoffMs := envInt("EMBEDDER_RETRY_BACKOFF_MS", defaultRetryBackoffMs)

	// internal recursive function
	var run func(context.Context, [][]byte, int) ([][]float32, []string, error)
	run = func(ctx context.Context, imgs [][]byte, depth int) ([][]float32, []string, error) {
		if len(imgs) == 0 {
			return nil, nil, errors.New("empty segment")
		}
		arr := make([]string, len(imgs))
		totalBytes := 0
		for i, b := range imgs {
			arr[i] = base64.StdEncoding.EncodeToString(b)
			totalBytes += len(b)
		}
		reqBody, _ := json.Marshal(imageBatchReq{ImagesB64: arr})

		attempt := 0
		for {
			attempt++
			start := time.Now()
			req, _ := http.NewRequestWithContext(ctx, http.MethodPost, baseURL()+"/embed/image/batch", bytes.NewReader(reqBody))
			req.Header.Set("Content-Type", "application/json")
			resp, err := httpClient.Do(req)
			elapsed := time.Since(start)
			if err != nil {
				// Identify timeout / network errors
				netErr, isNet := err.(net.Error)
				if isNet && netErr.Timeout() || errors.Is(err, context.DeadlineExceeded) {
					log.Printf("embed.ImageBatch timeout batch=%d bytes=%d attempt=%d elapsed=%dms depth=%d", len(imgs), totalBytes, attempt, elapsed.Milliseconds(), depth)
				} else {
					log.Printf("embed.ImageBatch network error batch=%d err=%v attempt=%d depth=%d", len(imgs), err, attempt, depth)
				}
			} else {
				defer resp.Body.Close()
				var out imageBatchRes
				if err := decodeOrError(resp, &out); err != nil {
					log.Printf("embed.ImageBatch server error status=%d batch=%d attempt=%d depth=%d err=%v", resp.StatusCode, len(imgs), attempt, depth, err)
				} else {
					// success
					errStrings := make([]string, len(out.Vecs))
					for i := range out.Vecs {
						if i < len(out.Errors) {
							if e := out.Errors[i]; e != nil {
								errStrings[i] = *e
							}
						}
						var diag *embeddingDiag
						if i < len(out.Diagnostics) {
							diag = out.Diagnostics[i]
						}
						if len(out.Vecs[i]) == 0 {
							if diag != nil && errStrings[i] == "" {
								errStrings[i] = "empty vector"
							}
							continue
						}
						if err := validateVec(out.Vecs[i], diag); err != nil {
							errStrings[i] = mergeErr(errStrings[i], err)
							out.Vecs[i] = nil
						}
					}
					log.Printf("embed.ImageBatch ok batch=%d bytes=%d elapsed=%dms attempt=%d depth=%d", len(imgs), totalBytes, elapsed.Milliseconds(), attempt, depth)
					return out.Vecs, errStrings, nil
				}
			}

			if attempt <= maxRetries {
				sleep := time.Duration(backoffMs*attempt) * time.Millisecond
				time.Sleep(sleep)
				continue
			}

			// after retries failed: if we can split, split
			if len(imgs) > 1 {
				if len(imgs) >= envInt("EMBEDDER_SPLIT_THRESHOLD", defaultSplitThreshold) {
					mid := len(imgs) / 2
					log.Printf("embed.ImageBatch splitting batch=%d depth=%d", len(imgs), depth)
					leftVecs, leftErrs, lErr := run(ctx, imgs[:mid], depth+1)
					rightVecs, rightErrs, rErr := run(ctx, imgs[mid:], depth+1)
					// merge results preserving order; errors bubble if both halves fail
					mergedVecs := append(leftVecs, rightVecs...)
					mergedErrs := append(leftErrs, rightErrs...)
					if lErr != nil && rErr != nil {
						return mergedVecs, mergedErrs, fmt.Errorf("both splits failed: left=%v right=%v", lErr, rErr)
					}
					return mergedVecs, mergedErrs, nil
				}
			}
			return nil, nil, fmt.Errorf("image batch failed after retries batch=%d", len(imgs))
		}
	}
	vecs, errs, err := run(ctx, imagesB64, 0)
	if err != nil {
		noteFailure(err)
	} else {
		noteSuccess()
	}
	return vecs, errs, err
}
