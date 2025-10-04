package handlers

import (
    "context"
    "log"
    "strings"
    "github.com/gofiber/fiber/v2"
    "github.com/TAURAAI/taura/api-gateway/internal/db"
)

type UpsertUserRequest struct {
    Email   string `json:"email"`
    Name    string `json:"name,omitempty"`
    Picture string `json:"picture,omitempty"`
}

type UpsertUserResponse struct {
    ID    string `json:"id"`
    Email string `json:"email"`
}

func PostUpsertUser(c *fiber.Ctx) error {
    var req UpsertUserRequest
    if err := c.BodyParser(&req); err != nil {
        return fiber.NewError(fiber.StatusBadRequest, "invalid body")
    }
    email := strings.TrimSpace(strings.ToLower(req.Email))
    if email == "" { return fiber.NewError(fiber.StatusBadRequest, "email required") }

    database, ok := c.Locals("db").(*db.Database)
    if !ok || database == nil { return fiber.NewError(fiber.StatusInternalServerError, "db missing") }

    ctx := context.Background()
    var id string
    // Basic upsert on email; ignore name/picture for now (could store in separate profile table later)
    err := database.Pool.QueryRow(ctx, `INSERT INTO users (email) VALUES ($1)
        ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email
        RETURNING id`, email).Scan(&id)
    if err != nil {
        log.Printf("[AUTH] upsert user error email=%s err=%v", email, err)
        return fiber.NewError(fiber.StatusInternalServerError, "upsert failed")
    }
    return c.JSON(UpsertUserResponse{ID: id, Email: email})
}
