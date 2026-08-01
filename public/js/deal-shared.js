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

  // ── B4.1 Buy-box completeness ───────────────────────────────────
  // matchesDeal treats every blank buyer field as a wildcard: no states means
  // every state, max_price 0 means any price. That is deliberate (a buyer we
  // know nothing about still hears about deals) but it means a "300 matched"
  // audience can be mostly blanks. This classifier is what lets the UI say so.
  //
  //   wildcard — no state, no real strategy, no money cap, no bed floor:
  //              this buyer matches literally every deal we will ever send.
  //   full     — market + strategy + a money cap, i.e. a box worth trusting.
  //   partial  — something on file, but not enough to call it a buy box.
  //
  // Purely descriptive: it must never be wired into matchesDeal or the send
  // path. Who receives a blast does not change because of this function.
  function buyBoxCompleteness(buyer) {
    const b = buyer || {};
    const strats = String(b.strategy || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
    const hasStrategy = strats.length > 0 && !strats.includes("all");
    const hasStates = !!String(b.states || "").trim();
    const hasMoney = Number(b.max_price) > 0 || Number(b.max_piti) > 0;
    const hasBeds = Number(b.min_beds) > 0;
    if (!hasStates && !hasStrategy && !hasMoney && !hasBeds) return "wildcard";
    return (hasStates && hasStrategy && hasMoney) ? "full" : "partial";
  }

  // Audience split for the blast modal: how much of a matched list is a real
  // match versus a blank passing through.
  function buyBoxSplit(buyers) {
    const out = { full: 0, partial: 0, wildcard: 0, total: 0 };
    for (const b of (buyers || [])) { out[buyBoxCompleteness(b)]++; out.total++; }
    return out;
  }

  // ── B4.4 Tolerance bands (near misses) ──────────────────────────
  // matchesDeal is a hard cutoff, which is right for the send: a $340k cap
  // means $340k. But a buyer $10k under on a deal they'd obviously look at is
  // invisible today, and their cap is usually a number they typed once.
  //
  // A near miss fails matchesDeal ONLY on the numeric constraints, and only
  // just. State and strategy are never "close" — a Florida buyer is not a
  // near miss on an Ohio deal — so a mismatch there disqualifies outright.
  //
  // Advisory only. Near misses are surfaced for the human to opt in one at a
  // time; nothing here loosens matchesDeal or the audience a blast sends to.
  const NEAR_MISS_TOLERANCE = 0.10; // 10% over a money cap
  const NEAR_MISS_BED_SLACK = 1;    // one bedroom short of their minimum

  function nearMissDeal(buyer, dealStrategy, state, price, piti, beds, tolerance) {
    const b = buyer || {};
    const tol = tolerance == null ? NEAR_MISS_TOLERANCE : Number(tolerance) || 0;
    if (matchesDeal(b, dealStrategy, state, price, piti, beds)) return null;

    // Hard filters: must pass exactly, same as matchesDeal.
    const strats = String(b.strategy || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
    if (strats.length && !strats.includes("all") && dealStrategy && !strats.includes(dealStrategy)) return null;
    const states = String(b.states || "").trim();
    if (states && state && !states.split(",").map(s => s.trim().toUpperCase()).includes(state.toUpperCase())) return null;

    const reasons = [];
    const overPct = (n, cap) => Math.round(((n - cap) / cap) * 100);
    if (b.max_price > 0 && price > 0 && price > b.max_price) {
      if (price > b.max_price * (1 + tol)) return null;
      reasons.push(`${overPct(price, b.max_price)}% over their ${fmtMoney(b.max_price)} price cap`);
    }
    if (b.max_piti > 0 && piti > 0 && piti > b.max_piti) {
      if (piti > b.max_piti * (1 + tol)) return null;
      reasons.push(`${overPct(piti, b.max_piti)}% over their ${fmtMoney(b.max_piti)}/mo PITI cap`);
    }
    if (b.min_beds > 0 && beds > 0 && beds < b.min_beds) {
      if (b.min_beds - beds > NEAR_MISS_BED_SLACK) return null;
      reasons.push(`${beds} bd vs their ${b.min_beds} bd minimum`);
    }
    return reasons.length ? { reasons } : null;
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

  // ── Buyer engagement score (0–100) ──────────────────────────────
  // Weighted, capped points per signal, then a recency decay on the buyer's
  // last touch. Interpretation: ≥60 hot (call now), 25–59 warm, 1–24 quiet.
  const ENGAGEMENT_WEIGHTS = {
    interest:  { pts: 30, cap: 60 }, // "I'm interested" taps / interested+ leads
    reply:     { pts: 12, cap: 36 }, // email/SMS replies captured
    view:      { pts: 8,  cap: 24 }, // deck page views
    longDwell: { pts: 5,  cap: 10 }, // deck views with 60s+ on the page
    pdf:       { pts: 5,  cap: 15 }, // deal-deck PDF downloads
    click:     { pts: 6,  cap: 18 }, // email link clicks
    open:      { pts: 2,  cap: 10 }, // email opens (weak signal, low cap)
  };

  // B4.6 — the score has to be able to go DOWN. Opens and clicks alone can
  // make someone who reported us for spam look like a live buyer, and the
  // score is what the "call today" strip and the sort order run on.
  //
  // A complaint is disqualifying on its own (resend-events.js already sets
  // email_opt_out on one), so it outweighs a full positive score. A hard
  // bounce is weaker: the address is dead, the person may not be.
  const ENGAGEMENT_PENALTIES = {
    complaint: { pts: -100, cap: -100 }, // marked an email as spam
    bounce:    { pts: -15,  cap: -30 },  // hard bounce — this address is dead
  };

  // counts: {interest, reply, view, longDwell, pdf, click, open,
  //          complaint, bounce} (missing = 0)
  // lastTouchAt: ISO string / Date of the buyer's most recent signal.
  function engagementScore(counts, lastTouchAt, now = Date.now()) {
    counts = counts || {};
    let raw = 0;
    for (const k in ENGAGEMENT_WEIGHTS) {
      const { pts, cap } = ENGAGEMENT_WEIGHTS[k];
      raw += Math.min((Number(counts[k]) || 0) * pts, cap);
    }
    if (!raw) return 0;
    let penalty = 0;
    for (const k in ENGAGEMENT_PENALTIES) {
      const { pts, cap } = ENGAGEMENT_PENALTIES[k];
      penalty += Math.max((Number(counts[k]) || 0) * pts, cap);
    }
    const days = lastTouchAt ? (now - new Date(lastTouchAt).getTime()) / 86400000 : Infinity;
    const decay = days <= 7 ? 1 : days <= 30 ? 0.6 : days <= 90 ? 0.35 : 0.2;
    // Positives are clamped to the 0–100 scale BEFORE the penalty is applied,
    // so a complaint (−100) is disqualifying no matter how much history sits
    // behind it — otherwise a buyer with a maxed-out raw score would survive
    // reporting us for spam. The penalty is not itself decayed: a complaint
    // doesn't become less true because it was a while ago.
    const positive = Math.min(100, raw * decay);
    const score = positive + penalty;
    if (score <= 0) return 0;
    return Math.max(1, Math.round(score));
  }

  function engagementLevel(score) {
    return score >= 60 ? "hot" : score >= 25 ? "warm" : score > 0 ? "quiet" : "none";
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

  return {
    fmtMoney, fmtPct, matchesDeal, buyerCashAtClose, dscrMonthlyPayment,
    subtoSummaryRows, morbyTermRows, engagementScore, engagementLevel, ENGAGEMENT_WEIGHTS,
    ENGAGEMENT_PENALTIES, buyBoxCompleteness, buyBoxSplit,
    nearMissDeal, NEAR_MISS_TOLERANCE, NEAR_MISS_BED_SLACK,
  };
});
