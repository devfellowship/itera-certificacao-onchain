import type { NextFunction, Request, Response } from "express";
import { operatorApiKey } from "../config.js";

/** Gate for the vendor-operator-only endpoints — see config.ts `operatorApiKey` for why this is a
 * shared header key rather than full user auth. */
export function requireOperator(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header("x-operator-key");
  if (!provided || provided !== operatorApiKey()) {
    res.status(401).json({ error: "missing or invalid x-operator-key" });
    return;
  }
  next();
}
