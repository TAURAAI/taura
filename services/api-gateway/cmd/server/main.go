package main

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/TAURAAI/taura/api-gateway/internal/db"
	"github.com/TAURAAI/taura/api-gateway/internal/embed"
	"github.com/TAURAAI/taura/api-gateway/internal/handlers"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/joho/godotenv"
)

func loadRootEnv() {
	_ = godotenv.Load()
	if os.Getenv("DATABASE_URL") != "" {
		return
	}
	wd, _ := os.Getwd()
	for i := 0; i < 6; i++ {
		candidate := filepath.Join(wd, ".env")
		if _, err := os.Stat(candidate); err == nil {
			_ = godotenv.Overload(candidate)
			if os.Getenv("DATABASE_URL") != "" {
				return
			}
		}
		if _, err := os.Stat(filepath.Join(wd, ".git")); err == nil {
			break
		}
		wd = filepath.Dir(wd)
	}
}

func main() {
	loadRootEnv()
	ctx := context.Background()
	database, err := db.Connect(ctx)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer database.Close()

	if err := database.AutoMigrate(ctx); err != nil {
		log.Printf("auto migrate error: %v", err)
	}
	if err := database.EnsureMediaUserUriUnique(ctx); err != nil {
		log.Printf("ensure unique (user_id,uri) index error: %v", err)
	}

	embed.InitImageProcessor(database)
	embed.StartHealthMonitor(ctx)

	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(recover.New())
	app.Use(logger.New())
	app.Use(cors.New(cors.Config{
		AllowOrigins:     "*",
		AllowMethods:     "GET,POST,OPTIONS",
		AllowHeaders:     "Content-Type,Authorization",
		AllowCredentials: false,
	}))

	// inject db into context via locals middleware
	app.Use(func(c *fiber.Ctx) error { c.Locals("db", database); return c.Next() })

	app.Get("/healthz", func(c *fiber.Ctx) error { return c.SendString("ok") })
	app.Get("/health", func(c *fiber.Ctx) error { return c.SendString("ok") })
	app.Options("/search", func(c *fiber.Ctx) error { return c.SendStatus(fiber.StatusNoContent) })
	app.Post("/search", handlers.PostSearch)
	app.Post("/sync", handlers.PostSync)
	app.Post("/sync/stream", handlers.PostSyncStream)
	app.Get("/stats", handlers.GetStats)

	// trigger embedder warmup asynchronously (non-blocking)
	go func() {
		warmURL := os.Getenv("EMBEDDER_URL")
		if warmURL == "" {
			warmURL = "http://localhost:9000"
		}
		client := &http.Client{Timeout: 20 * time.Second}
		start := time.Now()
		resp, err := client.Post(warmURL+"/warmup", "application/json", bytes.NewReader([]byte("{}")))
		if err != nil {
			log.Printf("embedder warmup request failed err=%v", err)
			return
		}
		resp.Body.Close()
		log.Printf("embedder warmup triggered elapsed=%dms", time.Since(start).Milliseconds())
	}()

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("api-gateway listening on :%s", port)
	if err := app.Listen(":" + port); err != nil {
		log.Fatalf("listen error: %v", err)
	}
}
