// LawinServer writes its routes as async functions. Express 4 doesn't catch errors in them:
// the request would never get an answer (and without a handler for unhandledRejection Node would
// stop the whole backend). Here a rejected promise is passed on to next(err) – the way Express 5
// does it by itself. Works for every router, because the bundle holds only one copy of Express.

type Next = (err?: unknown) => void;
type Handler = (req: unknown, res: unknown, next: Next) => unknown;
interface LayerPrototype {
  handle: Handler;
  handle_request(this: LayerPrototype, req: unknown, res: unknown, next: Next): void;
}

export function forwardAsyncErrors(): void {
  // internal file of express@4 (the version is pinned in package.json)
  const Layer = require("express/lib/router/layer") as { prototype: LayerPrototype };

  Layer.prototype.handle_request = function handle(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next(); // error handler, as in the original

    try {
      const result = fn(req, res, next);
      if (result instanceof Promise) result.catch((err: unknown) => next(err ?? new Error("promise rejected without a reason")));
    } catch (err) {
      next(err);
    }
  };
}
