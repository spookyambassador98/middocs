import type { NextFunction, Request, RequestHandler, Response } from "express";

// Express 4 doesn't forward rejected promises from async handlers to the
// error middleware on its own; without this, a thrown error in an async
// route just hangs the request. Wrap every async handler with this.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
