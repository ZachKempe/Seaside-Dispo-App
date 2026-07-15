// Shared, pure deal logic used by BOTH the browser pages and the Netlify
// functions. This is the single source of truth for buyer matching and deal
// money math — the blast preview (dashboard), the live send (send-blast.js),
// the emails, and the deck page must all agree, so they all import from here.
//
//   Browser:  <script src="/js/deal-shared.js"></script>  → window.DealShared
//   Node:     const { matchesDeal, ... } = require("../../public/js/deal-shared");
//
// Keep this file free of I/O, DOM access, and env vars.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DealShared = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ── Formatting ──────────────────────────────────────────────────
  function fmtMoney(n) {
    n = Number(n) || 0;
    return n ? `$${n.toLocaleString()}` : "—";
  }
  function fmtPct(n) {
    return n ? `${Number(n).toFixed(2)}%` : "—";
  }

  // ── Buyer matching (blast targeting) ────────────────────────────
  // A buyer matches a deal if their strategy is "all"/empty or includes the
  // deal's strategy (buyers can hold several, comma-separated: "subto,morby").
  // State/price/PITI/beds filters only apply when both sides have a value.
  function matchesDeal(buyer, dealStrategy, state, price, piti, beds) {
    const strats = String(buyer.strategy || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
    if (strats.length && !strats.includes("all") && dealStrategy && !strats.includes(dealStrategy)) return false;
    const states = (buyer.states || "").trim();
    if (states && state && !states.split(",").map(s => s.trim().toUpperCase()).includes(state.toUpperCase())) return false;
    if (buyer.max_price > 0 && price > 0 && price > buyer.max_price) return false;
    if (buyer.max_piti > 0 && piti > 0 && piti > buyer.max_piti) return false;
    if (buyer.min_beds > 0 && beds > 0 && beds < buyer.min_beds) return false;
    return true;
  }

  // ── Morby / Stack Method money math ─────────────────────────────
  // Cash the buyer receives at close = their 50% share of the assignment:
  //   loan proceeds (purchase × DSCR LTV: 75% SFH / 70% commercial)
  //   − down payment − 5% closing costs − additional broker fee, halved.
  // Returns 0 when the loan doesn't cover the costs (callers hide the line
  // rather than advertising a negative).
  function buyerCashAtClose(morby) {
    const price = Number(morby.purchase_price) || 0;
    if (!price) return 0;
    const defaultLtv = morby.property_type === "commercial" ? 70 : 75;
    const ltv = morby.dscr_ltv != null ? Number(morby.dscr_ltv) : defaultLtv;
    const loanProceeds = price * (ltv / 100);
    const downPayment = Number(morby.down_payment) || 0;
    const closingCosts = price * 0.05;
    const addlBrokerFee = price * ((Number(morby.additional_broker_pct) || 0) / 100);
    const buyerShare = (loanProceeds - downPayment - closingCosts - addlBrokerFee) / 2;
    return buyerShare > 0 ? buyerShare : 0;
  }

  // Standard 30-year amortizing monthly debt service on (price × ltv%).
  function dscrMonthlyPayment(price, ratePct, ltvPct, years = 30) {
    price = Number(price) || 0;
    ratePct = Number(ratePct) || 0;
    ltvPct = Number(ltvPct) || 0;
    const principal = price * (ltvPct / 100);
    const r = (ratePct / 100) / 12;
    const n = years * 12;
    if (!principal || !r) return 0;
    return principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  }

  // ── Term rows ([label, value] pairs, dashes filtered out) ───────
  // Sub-To rows for the deck page.
  function subtoSummaryRows(terms) {
    const rows = [
      ["Entry Fee", terms.entry_fee ? `${fmtMoney(terms.entry_fee)} + TC + CC` : "—"],
      ["Purchase Price", fmtMoney(terms.price)],
      ["Existing Loan Balance", fmtMoney(terms.mortgage)],
      ["PITI", terms.piti ? `${fmtMoney(terms.piti)}/mo` : "—"],
      ["Rate", terms.rate ? `${terms.rate}%` : "—"],
      ["Beds / Baths", terms.beds ? `${terms.beds} bd / ${terms.baths || "N/A"} ba` : "—"],
      ["Sqft", terms.sqft ? Number(terms.sqft).toLocaleString() : "—"],
      ["Year Built", terms.year_built || "—"],
    ];
    return rows.filter(([, v]) => v && v !== "—");
  }

  // Morby rows — shared by the deck page AND the Morby email's snapshot table.
  function morbyTermRows(morby) {
    const rows = [
      ["Purchase Price", fmtMoney(morby.purchase_price)],
      ["Down Payment", fmtMoney(morby.down_payment)],
      ["Seller Carry", fmtMoney(morby.seller_carry_balance)],
      ["Monthly Payment", fmtMoney(morby.monthly_payment)],
      ["Deferred Rate", fmtPct(morby.deferred_interest_rate)],
      ["Balloon", morby.balloon_months ? `${morby.balloon_months} months` : "—"],
      ["Inspection Period", morby.inspection_period_days ? `${morby.inspection_period_days} days` : "—"],
      ["Close of Escrow", morby.close_of_escrow_days ? `${morby.close_of_escrow_days} days` : "—"],
    ];
    return rows.filter(([, v]) => v && v !== "—");
  }

  return { fmtMoney, fmtPct, matchesDeal, buyerCashAtClose, dscrMonthlyPayment, subtoSummaryRows, morbyTermRows };
});
