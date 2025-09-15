package embed

import (
  "bytes"
  "encoding/json"
  "fmt"
  "io"
  "net/http"
  "os"
  "context"
  "time"
  "errors"
)

type textReq struct { Text string `json:"text"` }
type textRes struct { Vec []float32 `json:"vec"` }

type imageReq struct { URI string `json:"uri,omitempty"`; BytesBase64 string `json:"bytes_b64,omitempty"` }
type imageRes struct { Vec []float32 `json:"vec"` }

type batchTextReq struct { Texts []string `json:"texts"` }
type batchTextRes struct { Vecs [][]float32 `json:"vecs"` }

var httpClient = &http.Client{ Timeout: 8 * time.Second }

func baseURL() string {
  b := os.Getenv("EMBEDDER_URL")
  if b == "" { b = "http://localhost:9000" }
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

func Text(ctx context.Context, text string) ([]float32, error) {
  if text == "" { return nil, errors.New("empty text") }
  b, _ := json.Marshal(textReq{Text: text})
  req, _ := http.NewRequestWithContext(ctx, http.MethodPost, baseURL()+"/embed/text", bytes.NewReader(b))
  req.Header.Set("Content-Type","application/json")
  resp, err := httpClient.Do(req)
  if err != nil { return nil, err }
  defer resp.Body.Close()
  var tr textRes
  if err := decodeOrError(resp, &tr); err != nil { return nil, err }
  return tr.Vec, nil
}

func TextBatch(ctx context.Context, texts []string) ([][]float32, error) {
  if len(texts) == 0 { return nil, errors.New("empty batch") }
  b, _ := json.Marshal(batchTextReq{Texts: texts})
  req, _ := http.NewRequestWithContext(ctx, http.MethodPost, baseURL()+"/embed/text/batch", bytes.NewReader(b))
  req.Header.Set("Content-Type","application/json")
  resp, err := httpClient.Do(req)
  if err != nil { return nil, err }
  defer resp.Body.Close()
  var br batchTextRes
  if err := decodeOrError(resp, &br); err != nil { return nil, err }
  return br.Vecs, nil
}

func Image(ctx context.Context, uriOrB64 string, isBase64 bool) ([]float32, error) {
  payload := imageReq{}
  if isBase64 { payload.BytesBase64 = uriOrB64 } else { payload.URI = uriOrB64 }
  b, _ := json.Marshal(payload)
  req, _ := http.NewRequestWithContext(ctx, http.MethodPost, baseURL()+"/embed/image", bytes.NewReader(b))
  req.Header.Set("Content-Type","application/json")
  resp, err := httpClient.Do(req)
  if err != nil { return nil, err }
  defer resp.Body.Close()
  var ir imageRes
  if err := decodeOrError(resp, &ir); err != nil { return nil, err }
  return ir.Vec, nil
}
