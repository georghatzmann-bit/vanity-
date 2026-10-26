// Answers for endpoints that newer builds (Chapter 4 to 6) ask for and that LawinServer doesn't know.
// All harmless: empty lists or "nothing to do". Without these answers the builds would get 404 and
// keep asking (log noise, sometimes waiting at start).
import { Router } from "express";

/** Placeholder anti-cheat token – the same one the launcher passes as `-caldera=`. Nobody checks it. */
export const CALDERA_JWT =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoiYmU5ZGE1YzJmYmVhNDQwN2IyZjQwZWJhYWQ4NTlhZDQiLCJnZW5lcmF0ZWQiOjE2Mzg3MTcyNzgsImNhbGRlcmFHdWlkIjoiMzgxMGI4NjMtMmE2NS00NDU3LTliNTgtNGRhYjNiNDgyYTg2IiwiYWNQcm92aWRlciI6IkVhc3lBbnRpQ2hlYXQiLCJub3RlcyI6IiIsImZhbGxiYWNrIjpmYWxzZX0.VAWQB67RTxhiWOxx7DBjnzDnXyyEnX7OljJm-j2d88G_WgwQ9wrE6lwMEHZHjBd1ISJdUO1UVUqkfLdU5nofBQ";

export function createStubRouter(): Router {
  const r = Router();

  // Anti-cheat service (Caldera): the build asks for a token at start. Anti-cheat never runs.
  r.post("/caldera/api/v1/launcher/racp", (_req, res) => {
    res.json({ provider: "EasyAntiCheat", jwt: CALDERA_JWT });
  });

  // Parental controls / content controls: no limits.
  r.get(/^\/content-controls\/[^/]+$/, (_req, res) => {
    res.json({});
  });

  // Presence subscriptions (friends online): empty, there is no friends list at Epic.
  r.get(/^\/presence\/api\/v1\/_\/[^/]+\/settings\/subscriptions$/, (_req, res) => {
    res.json({});
  });
  r.all(/^\/presence\/api\/v1\/_\/[^/]+\/subscriptions(\/.*)?$/, (req, res) => {
    if (req.method === "GET") res.json([]);
    else res.status(204).end();
  });

  // User settings (avatar/banner request of newer builds): empty.
  r.get("/api/v1/user/setting", (_req, res) => {
    res.json([]);
  });

  return r;
}
