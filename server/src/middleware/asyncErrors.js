import Layer from 'express/lib/router/layer.js';

// Express 4 runs each handler inside a try/catch that only sees errors
// thrown synchronously. An async handler that rejects escapes it, reaches
// Node as an unhandled rejection, and Node 22 answers that by ending the
// process. One bad request then takes the whole API down for every member
// until Render restarts it, which is what "click a position and the whole
// website goes blank" was from Aug 6 to Sep 30 (getAnalystConsensus).
//
// This is Express 4's own handle_request with one addition: a returned
// promise that rejects goes to next(err) like a thrown error, so the
// error handler in index.js answers that request with a 500 and nobody
// else notices. Express 5 does this natively; drop this file on upgrade.
Layer.prototype.handle_request = function handle(req, res, next) {
  const fn = this.handle;

  if (fn.length > 3) {
    // Not a standard request handler (an error handler has four args).
    return next();
  }

  try {
    const ret = fn(req, res, next);
    if (ret && typeof ret.then === 'function') {
      ret.then(undefined, (err) => next(err || new Error('Handler rejected without a reason')));
    }
  } catch (err) {
    next(err);
  }
};
