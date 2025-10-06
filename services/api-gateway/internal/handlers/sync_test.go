package handlers

import (
	"context"
	"testing"

	"github.com/TAURAAI/taura/api-gateway/internal/db"
	"github.com/google/uuid"
)

func TestProcessSyncItemSkipsEmbeddingWhenExists(t *testing.T) {
	ctx := context.Background()
	originalUpsert := performUpsertMedia
	originalCheck := mediaEmbeddingExists
	defer func() {
		performUpsertMedia = originalUpsert
		mediaEmbeddingExists = originalCheck
	}()

	upsertCalls := 0
	performUpsertMedia = func(ctx context.Context, database *db.Database, userUUID string, item MediaUpsert) (string, bool, error) {
		upsertCalls++
		if item.URI != "file:///foo.jpg" {
			t.Fatalf("unexpected uri: %s", item.URI)
		}
		return "media-123", false, nil
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
