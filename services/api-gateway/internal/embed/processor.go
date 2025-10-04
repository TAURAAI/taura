package embed

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/TAURAAI/taura/api-gateway/internal/db"
)

type imageTask struct {
	mediaID  string
	uri      string
	bytes    []byte
	attempts int
}

type imageProcessor struct {
	db            *db.Database
	tasks         chan imageTask
	closed        chan struct{}
	wg            sync.WaitGroup
	batchSize     int
	flushInterval time.Duration
	maxAttempts   int
	retryDelay    time.Duration
	offerTimeout  time.Duration
}

var (
	processorOnce sync.Once
	processorInst *imageProcessor
)

func InitImageProcessor(database *db.Database) {
	processorOnce.Do(func() {
		if database == nil {
			log.Printf("embed queue not initialised: database nil")
			return
		}
		depth := envInt("EMBEDDER_QUEUE_DEPTH", 256)
		if depth <= 0 {
			depth = 256
		}
		batch := envInt("EMBEDDER_QUEUE_BATCH", 16)
		if batch <= 0 {
			batch = 16
		}
		flushMs := envInt("EMBEDDER_QUEUE_FLUSH_MS", 200)
		if flushMs <= 0 {
			flushMs = 200
		}
		maxAttempts := envInt("EMBEDDER_QUEUE_MAX_ATTEMPTS", 3)
		if maxAttempts <= 0 {
			maxAttempts = 3
		}
		retrySeconds := envInt("EMBEDDER_QUEUE_RETRY_SECONDS", 5)
		if retrySeconds <= 0 {
			retrySeconds = 5
		}
		offerMs := envInt("EMBEDDER_QUEUE_OFFER_TIMEOUT_MS", 5000)
		if offerMs < 0 {
			offerMs = 0
		}

		proc := &imageProcessor{
			db:            database,
			tasks:         make(chan imageTask, depth),
			closed:        make(chan struct{}),
			batchSize:     batch,
			flushInterval: time.Duration(flushMs) * time.Millisecond,
			maxAttempts:   maxAttempts,
			retryDelay:    time.Duration(retrySeconds) * time.Second,
		}
		if offerMs > 0 {
			proc.offerTimeout = time.Duration(offerMs) * time.Millisecond
		}
		processorInst = proc
		proc.wg.Add(1)
		go proc.run()
		log.Printf("embed queue initialised (depth=%d batch=%d flush=%dms retry=%ds)", depth, batch, flushMs, retrySeconds)
	})
}

func EnqueueImage(mediaID, uri string, bytes []byte) error {
	if processorInst == nil {
		return errors.New("embed queue not initialised")
	}
	task := imageTask{mediaID: mediaID, uri: uri, bytes: bytes}
	return processorInst.enqueue(task)
}

func QueueDepth() int {
	if processorInst == nil {
		return 0
	}
	return len(processorInst.tasks)
}

func (p *imageProcessor) enqueue(task imageTask) error {
	if p.offerTimeout <= 0 {
		select {
		case <-p.closed:
			return errors.New("embed queue closed")
		case p.tasks <- task:
			return nil
		}
	}

	timer := time.NewTimer(p.offerTimeout)
	defer timer.Stop()
	select {
	case <-p.closed:
		return errors.New("embed queue closed")
	case p.tasks <- task:
		return nil
	case <-timer.C:
		return fmt.Errorf("embed queue enqueue timeout after %s", p.offerTimeout)
	}
}

func (p *imageProcessor) run() {
	defer p.wg.Done()
	flushTicker := time.NewTimer(p.flushInterval)
	defer flushTicker.Stop()
	batch := make([]imageTask, 0, p.batchSize)
	for {
		select {
		case <-p.closed:
			if len(batch) > 0 {
				p.processBatch(batch)
			}
			return
		case task := <-p.tasks:
			batch = append(batch, task)
			if len(batch) >= p.batchSize {
				p.processBatch(batch)
				batch = make([]imageTask, 0, p.batchSize)
				if !flushTicker.Stop() {
					select {
					case <-flushTicker.C:
					default:
					}
				}
				flushTicker.Reset(p.flushInterval)
			}
		case <-flushTicker.C:
			if len(batch) > 0 {
				p.processBatch(batch)
				batch = make([]imageTask, 0, p.batchSize)
			}
			flushTicker.Reset(p.flushInterval)
		}
	}
}

func (p *imageProcessor) processBatch(batch []imageTask) {
	if len(batch) == 0 {
		return
	}
	payload := make([][]byte, len(batch))
	for i, task := range batch {
		payload[i] = task.bytes
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(envInt("EMBEDDER_QUEUE_REQUEST_TIMEOUT_SECONDS", 60))*time.Second)
	defer cancel()

	vecs, errs, err := ImageBatch(ctx, payload)
	if err != nil {
		log.Printf("embed queue batch failed count=%d err=%v", len(batch), err)
		for _, task := range batch {
			p.handleFailure(task, err.Error())
		}
		return
	}

	success := 0
	failures := 0
	for i, task := range batch {
		var vec []float32
		if i < len(vecs) {
			vec = vecs[i]
		}
		var perErr string
		if errs != nil && i < len(errs) {
			perErr = errs[i]
		}
		if len(vec) == 0 {
			if perErr == "" {
				perErr = "empty vector"
			}
			p.handleFailure(task, perErr)
			failures++
			continue
		}
		if err := p.persistEmbedding(ctx, task.mediaID, vec); err != nil {
			p.handleFailure(task, err.Error())
			failures++
			continue
		}
		success++
	}
	if failures > 0 {
		log.Printf("embed queue batch persisted success=%d failed=%d", success, failures)
	} else {
		log.Printf("embed queue batch persisted success=%d", success)
	}
}

func (p *imageProcessor) persistEmbedding(ctx context.Context, mediaID string, vec []float32) error {
	if mediaID == "" {
		return errors.New("missing media id")
	}
	parts := make([]string, len(vec))
	for i, f := range vec {
		parts[i] = fmt.Sprintf("%.9f", f)
	}
	vectorLiteral := "[" + strings.Join(parts, ",") + "]"
	_, err := p.db.Pool.Exec(ctx, `INSERT INTO media_vecs (media_id, embedding) VALUES ($1, $2::vector)
        ON CONFLICT (media_id) DO UPDATE SET embedding=EXCLUDED.embedding`, mediaID, vectorLiteral)
	return err
}

func (p *imageProcessor) handleFailure(task imageTask, reason string) {
	if reason == "" {
		reason = "unknown error"
	}
	if task.attempts+1 >= p.maxAttempts {
		log.Printf("embed queue giving up uri=%s attempts=%d reason=%s", task.uri, task.attempts+1, reason)
		return
	}
	retryTask := task
	retryTask.attempts++
	log.Printf("embed queue retry uri=%s attempt=%d reason=%s", retryTask.uri, retryTask.attempts, reason)
	go func(t imageTask) {
		select {
		case <-time.After(p.retryDelay):
			if err := p.enqueue(t); err != nil {
				log.Printf("embed queue requeue failed uri=%s err=%v", t.uri, err)
			}
		case <-p.closed:
			return
		}
	}(retryTask)
}
