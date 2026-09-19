import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "./utils.js";
import type { AuthUser } from "../types.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

  if (!token) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, email: payload.email, name: payload.name, color: payload.color };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
