package db

import (
    "context"
    "os"
    "log"
    "path/filepath"
    "strings"
    "io/ioutil"
)

func (d *Database) AutoMigrate(ctx context.Context) error {
    // Run by default unless explicitly disabled with AUTO_MIGRATE=false
    if v := strings.ToLower(os.Getenv("AUTO_MIGRATE")); v == "false" {
        return nil
    }
    wd, _ := os.Getwd()
    var schemaPath string
    for i := 0; i < 7; i++ {
        candidate := filepath.Join(wd, "packages", "schema", "pg.sql")
        if _, err := os.Stat(candidate); err == nil {
            schemaPath = candidate
            break
        }
        parent := filepath.Dir(wd)
        if parent == wd {
            break
        }
        wd = parent
    }
    if schemaPath == "" {
        return nil
    }
    bytes, err := ioutil.ReadFile(schemaPath)
    if err != nil { return err }
    sql := string(bytes)
    if _, err := d.Pool.Exec(ctx, sql); err != nil {
        return err
    }
    log.Println("auto migration applied from", schemaPath)
    return nil
}

func (d *Database) EnsureMediaUserUriUnique(ctx context.Context) error {
    var exists bool
    if err := d.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename='media' AND indexname='idx_media_user_uri')`).Scan(&exists); err != nil {
        return err
    }
    if exists { return nil }
    _, err := d.Pool.Exec(ctx, `WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id, uri ORDER BY id) AS rn FROM media
      )
      DELETE FROM media WHERE id IN (SELECT id FROM ranked WHERE rn > 1);`)
    if err != nil { return err }
    if _, err := d.Pool.Exec(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS idx_media_user_uri ON media(user_id, uri)`); err != nil {
        return err
    }
    log.Println("ensured unique index idx_media_user_uri (post-dedupe if needed)")
    return nil
}
