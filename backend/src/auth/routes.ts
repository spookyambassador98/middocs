import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { hashPassword, verifyPassword, signToken } from "./utils.js";
import { pickColorFor } from "./colors.js";
import { requireAuth } from "./middleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6, "Password must be at least 6 characters"),
  name: z.string().min(1).max(80),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/register", asyncHandler(async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const { email, password, name } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();

  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [normalizedEmail]);
  if (existing.rowCount && existing.rowCount > 0) {
    res.status(409).json({ error: "An account with this email already exists" });
    return;
  }

  const passwordHash = await hashPassword(password);
  const color = pickColorFor(normalizedEmail);

  const result = await pool.query(
    `INSERT INTO users (email, password_hash, name, color)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, name, color`,
    [normalizedEmail, passwordHash, name.trim(), color]
  );
  const user = result.rows[0];

  const token = signToken({ sub: user.id, email: user.email, name: user.name, color: user.color });
  res.status(201).json({ token, user });
}));

authRouter.post("/login", asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }
  const { email, password } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();

  const result = await pool.query(
    "SELECT id, email, name, color, password_hash FROM users WHERE email = $1",
    [normalizedEmail]
  );
  const user = result.rows[0];
  if (!user) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const token = signToken({ sub: user.id, email: user.email, name: user.name, color: user.color });
  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, color: user.color },
  });
}));

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});
