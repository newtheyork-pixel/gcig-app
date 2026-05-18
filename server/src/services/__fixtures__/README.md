Real SEC DEF 14A HTML excerpts (raw primary doc, trimmed to <=2MB),
captured via getProxyStatement for regression. Provenance: SEC EDGAR
public filings. Regenerate with the Task 7 capture script.

- AAPL / AMZN / KO — large-cap card-layout boards (Board path
  correctly empty; the SCT is the working tier here).
- MLAB — Mesa Labs DEF 14A filed 2025-07-11. The conventional
  small/mid-cap case: a textbook 7-row nominee roster the Board
  path must read. Guards the recall floor for ordinary tables.

Real SEC 10-K HTML excerpts for executiveBios.js. Full 10-Ks are
tens of MB, so each is trimmed-but-real: the contiguous "Information
about our Executive Officers" subtree plus a real sibling on each
side (so the heading-signature locate is genuinely exercised, not
fed the isolated section). Captured via the same app path the
service uses — getRecentFilings(limit:150) → newest 10-K → raw-URL
strip → SEC_UA fetch. Three structurally different shapes:

- AMZN-10k.html (~26 KB) — Amazon.com 10-K filed 2026-02-06,
  src .../1018724/000101872426000004/amzn-20251231.htm. Shape: a
  Name/Age/Position summary table then one bold-name prose
  paragraph per officer (the prose IS the bio). The trailing
  "Board of Directors" roster reuses the same columns, so it's
  kept in as the realistic sibling that the section bound must
  exclude (director Keith B. Alexander must not surface).
- KO-10k.html (~21 KB) — The Coca-Cola Company 10-K filed
  2026-02-20, src .../21344/000162828026010047/ko-20251231.htm.
  Shape: every officer is one <tr> [Name, Age, career-narrative];
  the narrative cell IS the bio. The table is split across a page
  break into two sibling <table>s (3 + 8 = 11 officers) — both
  must be read. ITEM 4 / Part II headings are the kept siblings.
- CAT-10k.html (~18 KB) — Caterpillar Inc. 10-K filed 2026-02-13,
  src .../18230/000001823026000008/cat-20251231.htm. The
  conventional substitute: MLAB and AAPL both incorporate Item 10
  by reference to the proxy and carry NO 10-K officer section
  (verified — not a parse miss), so neither could anchor the
  conventional-filer case; CAT does carry it. Shape: one table,
  the name cell trails a parenthetical age, two position columns
  hold the bio.
