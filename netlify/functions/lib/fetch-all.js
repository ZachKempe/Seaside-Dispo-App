// F3 — Supabase PostgREST returns at most 1,000 rows per request by default
// and truncates SILENTLY (no error). Any whole-table fetch in a function must
// go through this pager or it starts dropping rows past 1,000 buyers.
//
// Usage:
//   const { fetchAllRows } = require("./lib/fetch-all");
//   const buyers = await fetchAllRows(p => sb(p, { method: "GET" }),
//                                     "/buyers?active=eq.true&select=*");
//
// `sbGet` is whatever GET helper the calling function already has — the pager
// only appends limit/offset (and a deterministic order, without which
// PostgREST gives no cross-request ordering guarantee and pages can skip or
// duplicate rows). Pass { order: "card_id" } for tables keyed on card_id.

const PAGE_SIZE = 1000;

async function fetchAllRows(sbGet, path, { order = "id" } = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const orderParam = path.includes("order=") ? "" : `&order=${order}.asc`;
  const all = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const rows = (await sbGet(`${path}${sep}limit=${PAGE_SIZE}&offset=${offset}${orderParam}`)) || [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) return all;
  }
}

module.exports = { fetchAllRows, PAGE_SIZE };
