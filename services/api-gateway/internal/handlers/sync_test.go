package handlers

import (
	"context"
	"testing"
	"time"

	"github.com/TAURAAI/taura/api-gateway/internal/db"
	"github.com/google/uuid"
)

func TestProcessSyncItemSkipsEmbeddingWhenExists(t *testing.T) {
	ctx := context.Background()
	originalUpsert := performUpsertMedia
	originalCheck := mediaEmbeddingExists
	originalLookup := lookupExistingMediaTimestamp
	defer func() {
		performUpsertMedia = originalUpsert
		mediaEmbeddingExists = originalCheck
		lookupExistingMediaTimestamp = originalLookup
	}()

	upsertCalls := 0
	performUpsertMedia = func(ctx context.Context, database *db.Database, userUUID string, item MediaUpsert) (string, bool, error) {
		upsertCalls++
		if item.URI != "file:///foo.jpg" {
			t.Fatalf("unexpected uri: %s", item.URI)
		}
		return "media-123", false, nil
	}

	lookupCalls := 0
	lookupExistingMediaTimestamp = func(ctx context.Context, database *db.Database, userUUID string, uri string) (*time.Time, error) {
		lookupCalls++
		if uri != "file:///foo.jpg" {
			t.Fatalf("unexpected lookup uri: %s", uri)
		}
		return nil, nil
	}

	checkCalls := 0
	mediaEmbeddingExists = func(ctx context.Context, database *db.Database, mediaID string) (bool, error) {
		checkCalls++
		if mediaID != "media-123" {
			t.Fatalf("unexpected media id: %s", mediaID)
		}
		return true, nil
	}

	item := MediaUpsert{
		UserID:   uuid.NewString(),
		Modality: "image",
		URI:      "file:///foo.jpg",
	}

	res := processSyncItem(ctx, &db.Database{}, item)

	if upsertCalls != 1 {
		t.Fatalf("expected 1 upsert call, got %d", upsertCalls)
	}
	if lookupCalls != 1 {
		t.Fatalf("expected 1 lookup call, got %d", lookupCalls)
	}
	if checkCalls != 1 {
		t.Fatalf("expected 1 embedding check call, got %d", checkCalls)
	}
	if res.requested != 0 {
		t.Fatalf("expected requested=0 got %d", res.requested)
	}
	if res.queued != 0 {
		t.Fatalf("expected queued=0 got %d", res.queued)
	}
}

func TestProcessSyncItemReembedsWhenTimestampChanges(t *testing.T) {
	ctx := context.Background()
	originalUpsert := performUpsertMedia
	originalCheck := mediaEmbeddingExists
	originalLookup := lookupExistingMediaTimestamp
	defer func() {
		performUpsertMedia = originalUpsert
		mediaEmbeddingExists = originalCheck
		lookupExistingMediaTimestamp = originalLookup
	}()

	performUpsertMedia = func(ctx context.Context, database *db.Database, userUUID string, item MediaUpsert) (string, bool, error) {
		if item.URI != "file:///foo.jpg" {
			t.Fatalf("unexpected uri: %s", item.URI)
		}
		return "media-123", false, nil
	}

	oldTS := time.Now().Add(-time.Hour).UTC()
	lookupExistingMediaTimestamp = func(ctx context.Context, database *db.Database, userUUID string, uri string) (*time.Time, error) {
		if uri != "file:///foo.jpg" {
			t.Fatalf("unexpected lookup uri: %s", uri)
		}
		return &oldTS, nil
	}

	mediaEmbeddingExists = func(ctx context.Context, database *db.Database, mediaID string) (bool, error) {
		if mediaID != "media-123" {
			t.Fatalf("unexpected media id: %s", mediaID)
		}
		return true, nil
	}

	newTS := oldTS.Add(time.Minute).UTC().Format(time.RFC3339)
	inline := "aGVsbG8="
	item := MediaUpsert{
		UserID:   uuid.NewString(),
		Modality: "image",
		URI:      "file:///foo.jpg",
		TS:       &newTS,
		BytesB64: &inline,
	}

	res := processSyncItem(ctx, &db.Database{}, item)

	if res.requested != 1 {
		t.Fatalf("expected requested=1 got %d", res.requested)
	}
	if res.queued != 0 {
		t.Fatalf("expected queued=0 got %d", res.queued)
	}
	if len(res.embedFailures) != 1 {
		t.Fatalf("expected 1 embed failure got %d", len(res.embedFailures))
	}
	if res.embedFailures[0].URI != item.URI {
		t.Fatalf("unexpected failure uri: %s", res.embedFailures[0].URI)
	}
}
