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
    if os.Getenv("AUTO_MIGRATE") == "" || strings.ToLower(os.Getenv("AUTO_MIGRATE")) == "false" {
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
