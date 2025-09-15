package main

import (
	"log"
	"os"
	"context"
	"path/filepath"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/joho/godotenv"
	"github.com/TAURAAI/taura/api-gateway/internal/handlers"
	"github.com/TAURAAI/taura/api-gateway/internal/db"
)

func loadRootEnv() {
	// Attempt local load first; then walk up to find repo root containing .git or AGENTS.md
	_ = godotenv.Load()
	if os.Getenv("DATABASE_URL") != "" { return }
	wd, _ := os.Getwd()
	for i := 0; i < 6; i++ { // climb up to 6 levels max
		candidate := filepath.Join(wd, ".env")
		if _, err := os.Stat(candidate); err == nil {
			_ = godotenv.Overload(candidate)
			if os.Getenv("DATABASE_URL") != "" { return }
		}
		// Heuristic: stop if we see a .git folder
		if _, err := os.Stat(filepath.Join(wd, ".git")); err == nil { break }
		wd = filepath.Dir(wd)
	}
}

func main() {
	loadRootEnv()
	ctx := context.Background()
	database, err := db.Connect(ctx)
	if err != nil { log.Fatalf("db connect: %v", err) }
	defer database.Close()

	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(recover.New())
	app.Use(logger.New())

	// inject db into context via locals middleware
	app.Use(func(c *fiber.Ctx) error { c.Locals("db", database); return c.Next() })

	app.Get("/healthz", func(c *fiber.Ctx) error { return c.SendString("ok") })
	app.Post("/search", handlers.PostSearch)
	app.Post("/sync", handlers.PostSync)

	port := os.Getenv("PORT")
	if port == "" { port = "8080" }
	log.Printf("api-gateway listening on :%s", port)
	if err := app.Listen(":" + port); err != nil {
		log.Fatalf("listen error: %v", err)
	}
}

