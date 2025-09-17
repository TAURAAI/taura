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
  "encoding/base64"
  "strconv"
)

type textReq struct { Text string `json:"text"` }
type textRes struct { Vec []float32 `json:"vec"` }

type imageReq struct { URI string `json:"uri,omitempty"`; BytesBase64 string `json:"bytes_b64,omitempty"` }
type imageRes struct { Vec []float32 `json:"vec"` }
type imageBatchReq struct { ImagesB64 []string `json:"images_b64"` }
type imageBatchRes struct { Vecs [][]float32 `json:"vecs"`; Errors [] *string `json:"errors"` }

type batchTextReq struct { Texts []string `json:"texts"` }
type batchTextRes struct { Vecs [][]float32 `json:"vecs"` }

var httpClient = &http.Client{ Timeout: 8 * time.Second }

func configureTimeoutFromEnv() {
  if v := os.Getenv("EMBEDDER_HTTP_TIMEOUT_SECONDS"); v != "" {
    if n, err := strconv.Atoi(v); err == nil && n > 0 {
      httpClient.Timeout = time.Duration(n) * time.Second
    }
  } else {
    httpClient.Timeout = 30 * time.Second
  }
}

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
  configureTimeoutFromEnv()
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
  configureTimeoutFromEnv()
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
  configureTimeoutFromEnv()
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

func ImageBatch(ctx context.Context, imagesB64 [][]byte) ([][]float32, []string, error) {
  configureTimeoutFromEnv()
  if len(imagesB64) == 0 { return nil, nil, errors.New("empty image batch") }
  arr := make([]string, len(imagesB64))
  for i, b := range imagesB64 { arr[i] = base64.StdEncoding.EncodeToString(b) }
  reqBody, _ := json.Marshal(imageBatchReq{ImagesB64: arr})
  req, _ := http.NewRequestWithContext(ctx, http.MethodPost, baseURL()+"/embed/image/batch", bytes.NewReader(reqBody))
  req.Header.Set("Content-Type","application/json")
  resp, err := httpClient.Do(req)
  if err != nil { return nil, nil, err }
  defer resp.Body.Close()
  var out imageBatchRes
  if err := decodeOrError(resp, &out); err != nil { return nil, nil, err }
  errStrings := make([]string, len(out.Errors))
  for i, e := range out.Errors { if e != nil { errStrings[i] = *e } }
  return out.Vecs, errStrings, nil
}
