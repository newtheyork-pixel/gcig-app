// Authenticated JSON must not be stored by a browser cache.
//
// Express answers every /api route with an ETag and, until this
// header, no Cache-Control at all. The browser treats that as
// permission to keep the response. Hours later it replays the stored
// 200 — headers included — and one of those headers is X-New-Token.
// The client adopts a credential minted this morning, the next call
// 401s AUTH, and a member who did nothing wrong is signed out. That
// is how the Mac app "came to delete its own valid session at launch",
// and the website was on the same path.
//
// Routes that want to be cached (the SEC document proxy) set their
// own Cache-Control after this and overwrite it.
export function noStoreApi(_req, res, next) {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
}
