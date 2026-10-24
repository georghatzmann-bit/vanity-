// LawinServer schreibt seine Routen als async-Funktionen. Express 4 fängt Fehler darin nicht ab:
// Die Anfrage bekäme nie eine Antwort (und ohne Handler für unhandledRejection würde Node das ganze
// Backend beenden). Hier wird ein abgelehntes Promise an next(err) weitergereicht – so wie es
// Express 5 von sich aus macht. Gilt für alle Router, weil im Bundle nur eine Express-Kopie steckt.

type Next = (err?: unknown) => void;
type Handler = (req: unknown, res: unknown, next: Next) => unknown;
interface LayerPrototype {
  handle: Handler;
  handle_request(this: LayerPrototype, req: unknown, res: unknown, next: Next): void;
}

export function forwardAsyncErrors(): void {
  // interne Datei von express@4 (Version ist in package.json fest angegeben)
  const Layer = require("express/lib/router/layer") as { prototype: LayerPrototype };

  Layer.prototype.handle_request = function handle(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next(); // Fehler-Handler, wie im Original

    try {
      const result = fn(req, res, next);
      if (result instanceof Promise) result.catch((err: unknown) => next(err ?? new Error("Promise ohne Grund abgelehnt")));
    } catch (err) {
      next(err);
    }
  };
}
