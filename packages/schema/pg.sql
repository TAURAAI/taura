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

-- Ensure a user cannot have duplicate URI entries
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_user_uri ON media(user_id, uri);

-- Drop helper view so we can recreate tables when dimensions change
DROP VIEW IF EXISTS media_with_vec;

-- Ensure media_vecs exists with the target embedding dimension (1152 for SigLIP So400M)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'media_vecs' AND relkind = 'r') THEN
    PERFORM 1 FROM pg_attribute
      WHERE attrelid = 'media_vecs'::regclass
        AND attname = 'embedding'
        AND atttypmod = (1152 + 4); -- pgvector stores dim as typmod-4
    IF NOT FOUND THEN
      RAISE NOTICE 'Recreating media_vecs with embedding dimension 1152';
      DROP TABLE media_vecs CASCADE;
    END IF;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS media_vecs (
  media_id uuid PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  embedding vector(1152) NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_media_user_ts ON media(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_media_vecs_embedding
  ON media_vecs USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE OR REPLACE VIEW media_with_vec AS
SELECT m.*, (mv.media_id IS NOT NULL) AS has_vec
FROM media m
LEFT JOIN media_vecs mv ON mv.media_id = m.id;
