package db

import (
  "context"
  "os"
  "time"
  "log"
  "github.com/jackc/pgx/v5/pgxpool"
)

type Database struct {
  Pool *pgxpool.Pool
}

func Connect(ctx context.Context) (*Database, error) {
  dsn := os.Getenv("DATABASE_URL")
  if dsn == "" {
    dsn = "postgres://postgres:postgres@localhost:5432/taura?sslmode=disable"
  }
  cfg, err := pgxpool.ParseConfig(dsn)
  if err != nil { return nil, err }
  cfg.MaxConns = 10
  pool, err := pgxpool.NewWithConfig(ctx, cfg)
  if err != nil { return nil, err }
  ctxPing, cancel := context.WithTimeout(ctx, 5*time.Second)
  defer cancel()
  if err := pool.Ping(ctxPing); err != nil {
    return nil, err
  }
  log.Println("db connected")
  return &Database{Pool: pool}, nil
}

func (d *Database) Close() { if d.Pool != nil { d.Pool.Close() } }
