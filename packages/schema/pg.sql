-- Enable pgcrypto for gen_random_uuid and pgvector extension
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE
);

-- Media table
CREATE TABLE IF NOT EXISTS media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  modality TEXT NOT NULL,
  uri TEXT NOT NULL,
  thumb_url TEXT,
  ts TIMESTAMPTZ,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  album TEXT,
  source TEXT,
  deleted BOOLEAN DEFAULT FALSE
);

-- Media vectors
CREATE TABLE IF NOT EXISTS media_vecs (
  media_id uuid PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  embedding vector(768) NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_media_user_ts ON media(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_media_vecs_embedding
  ON media_vecs USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Simple view joining media + vector existence
CREATE OR REPLACE VIEW media_with_vec AS
SELECT m.*, (mv.media_id IS NOT NULL) AS has_vec
FROM media m
LEFT JOIN media_vecs mv ON mv.media_id = m.id;
