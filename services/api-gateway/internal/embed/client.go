package embed

import (
  "bytes"
  "encoding/json"
  "net/http"
  "os"
  "context"
  "time"
)

type textReq struct { Text string `json:"text"` }
type textRes struct { Vec []float32 `json:"vec"` }

var httpClient = &http.Client{ Timeout: 8 * time.Second }

func Text(ctx context.Context, text string) ([]float32, error) {
  base := os.Getenv("EMBEDDER_URL")
  if base == "" { base = "http://localhost:9000" }
  b, _ := json.Marshal(textReq{Text: text})
  req, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+"/embed/text", bytes.NewReader(b))
  req.Header.Set("Content-Type","application/json")
  resp, err := httpClient.Do(req)
  if err != nil { return nil, err }
  defer resp.Body.Close()
  var tr textRes
  if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil { return nil, err }
  return tr.Vec, nil
}
