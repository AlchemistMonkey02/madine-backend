const express = require('express');

// Express 4 doesn't catch rejected promises from async handlers — without
// this, one failed database call would crash the whole server. Routes on this
// router forward those errors to the JSON error handler in server.js instead.
function asyncRouter() {
  const router = express.Router();
  for (const method of ['get', 'post', 'put', 'delete']) {
    const original = router[method].bind(router);
    router[method] = (path, ...handlers) =>
      original(path, ...handlers.map((h) => (req, res, next) => {
        try {
          const result = h(req, res, next);
          if (result && typeof result.catch === 'function') result.catch(next);
        } catch (err) {
          next(err);
        }
      }));
  }
  return router;
}

module.exports = { asyncRouter };
