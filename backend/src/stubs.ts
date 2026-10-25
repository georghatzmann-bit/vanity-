// Antworten für Endpunkte, die neuere Builds (Chapter 4 bis 6) anfragen und die LawinServer nicht kennt.
// Alles harmlos: leere Listen oder „nichts zu tun“. Ohne diese Antworten bekämen die Builds 404 und
// fragten immer wieder nach (Log-Rauschen, teils Wartezeiten beim Start).
import { Router } from "express";

/** Platzhalter-Anti-Cheat-Token – derselbe, den der Launcher als `-caldera=` mitgibt. Prüft niemand. */
export const CALDERA_JWT =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoiYmU5ZGE1YzJmYmVhNDQwN2IyZjQwZWJhYWQ4NTlhZDQiLCJnZW5lcmF0ZWQiOjE2Mzg3MTcyNzgsImNhbGRlcmFHdWlkIjoiMzgxMGI4NjMtMmE2NS00NDU3LTliNTgtNGRhYjNiNDgyYTg2IiwiYWNQcm92aWRlciI6IkVhc3lBbnRpQ2hlYXQiLCJub3RlcyI6IiIsImZhbGxiYWNrIjpmYWxzZX0.VAWQB67RTxhiWOxx7DBjnzDnXyyEnX7OljJm-j2d88G_WgwQ9wrE6lwMEHZHjBd1ISJdUO1UVUqkfLdU5nofBQ";

export function createStubRouter(): Router {
  const r = Router();

  // Anti-Cheat-Dienst (Caldera): der Build fragt beim Start nach einem Token. Anti-Cheat läuft nie.
  r.post("/caldera/api/v1/launcher/racp", (_req, res) => {
    res.json({ provider: "EasyAntiCheat", jwt: CALDERA_JWT });
  });

  // Kindersicherung / Inhaltskontrollen: keine Einschränkungen.
  r.get(/^\/content-controls\/[^/]+$/, (_req, res) => {
    res.json({});
  });

  // Anwesenheits-Abos (Freunde online): leer, es gibt keine Freundesliste bei Epic.
  r.get(/^\/presence\/api\/v1\/_\/[^/]+\/settings\/subscriptions$/, (_req, res) => {
    res.json({});
  });
  r.all(/^\/presence\/api\/v1\/_\/[^/]+\/subscriptions(\/.*)?$/, (req, res) => {
    if (req.method === "GET") res.json([]);
    else res.status(204).end();
  });

  // Nutzereinstellungen (Avatar/Banner-Abfrage neuerer Builds): leer.
  r.get("/api/v1/user/setting", (_req, res) => {
    res.json([]);
  });

  return r;
}
