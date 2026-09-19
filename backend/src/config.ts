import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  instanceId: process.env.INSTANCE_ID ?? `local-${process.pid}`,
  databaseUrl: required("DATABASE_URL", "postgres://mgd:mgd_password@localhost:5432/mini_google_docs"),
  redisUrl: required("REDIS_URL", "redis://localhost:6379"),
  jwtSecret: required("JWT_SECRET", "dev_secret_change_me"),
  jwtExpiresIn: "7d" as const,
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:8080",
  // How long after the last edit to a document before its full Yjs state
  // is flushed to Postgres. Keeps writes cheap under bursty typing while
  // bounding how much would be lost if an instance crashed mid-edit.
  persistDebounceMs: Number(process.env.PERSIST_DEBOUNCE_MS ?? 2000),
};
