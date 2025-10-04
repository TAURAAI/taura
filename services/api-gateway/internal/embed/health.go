package embed

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

type HealthStatus struct {
	Healthy     bool      `json:"healthy"`
	LastChecked time.Time `json:"last_checked"`
	LastSuccess time.Time `json:"last_success"`
	LastError   string    `json:"last_error,omitempty"`
}

var (
	healthMu     sync.RWMutex
	healthStatus = HealthStatus{}
	monitorOnce  sync.Once
)

const defaultHealthIntervalSeconds = 10

func noteSuccess() {
	now := time.Now()
	healthMu.Lock()
	prev := healthStatus
	healthStatus.Healthy = true
	healthStatus.LastChecked = now
	healthStatus.LastSuccess = now
	healthStatus.LastError = ""
	healthMu.Unlock()
	if !prev.Healthy {
		log.Printf("embedder health recovered (previous error: %s)", prev.LastError)
	}
}

func noteFailure(err error) {
	now := time.Now()
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	healthMu.Lock()
	prev := healthStatus
	healthStatus.Healthy = false
	healthStatus.LastChecked = now
	if !prev.LastSuccess.IsZero() {
		healthStatus.LastSuccess = prev.LastSuccess
	}
	if msg != "" {
		healthStatus.LastError = msg
	}
	healthMu.Unlock()
	if prev.Healthy {
		log.Printf("embedder health degraded: %s", msg)
	}
}

func HealthSnapshot() HealthStatus {
	healthMu.RLock()
	defer healthMu.RUnlock()
	return healthStatus
}

func StartHealthMonitor(ctx context.Context) {
	monitorOnce.Do(func() {
		if ctx == nil {
			ctx = context.Background()
		}
		interval := time.Duration(envInt("EMBEDDER_HEALTH_INTERVAL_SECONDS", defaultHealthIntervalSeconds)) * time.Second
		if interval <= 0 {
			interval = defaultHealthIntervalSeconds * time.Second
		}
		go func() {
			ticker := time.NewTicker(interval)
			defer ticker.Stop()
			for {
				if err := CheckHealth(ctx); err != nil {
					noteFailure(err)
				} else {
					noteSuccess()
				}
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
		}()
	})
}

func CheckHealth(ctx context.Context) error {
	configureTimeoutFromEnv()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, baseURL()+"/healthz", nil)
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= http.StatusMultipleChoices {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("embedder health status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}
