// Shared, pure deal-formatting helpers used by both the blast emails and the
// interactive deck page. Keep these free of I/O so both can import them.

function fmtMoney(n) {
  n = Number(n) || 0;
  return n ? `$${n.toLocaleString()}` : "—";
}
function fmtPct(n) {
  return n ? `${Number(n).toFixed(2)}%` : "—";
}

// Estimated cash the buyer receives at close = their 50% share of the
// assignment. Mirrors send-blast.js buyerCashAtClose EXACTLY. If you dedupe,
// delete the copy in send-blast and import this one.
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

// Sub-To term rows for the deck page. [label, value] pairs, dashes filtered out.
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

// Morby term rows for the deck page. Same set the Morby email builds.
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

module.exports = { fmtMoney, fmtPct, buyerCashAtClose, subtoSummaryRows, morbyTermRows };
