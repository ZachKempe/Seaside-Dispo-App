// Is this request a bot rather than a person?
//
// Link-preview scrapers (iMessage, Slack, WhatsApp, Facebook, LinkedIn…) fetch
// every forwarded deck URL to read its Open Graph card. They MUST still get the
// page — that's the whole point of the card — but they are not people, and
// `deck_views` feeds the "N people viewed this in 24h" social proof on the deck
// page itself plus the dashboard's "Call today" strip and follow-up nudges.
// Counting a scraper there inflates numbers the business acts on. So: render for
// bots, log only humans.
//
// Matching is deliberately token-based, not brand-based. A bare /twitter/ or
// /whatsapp/ would also drop real people browsing inside those apps' in-app
// browsers, whose UAs carry the brand name too — the fetchers identify
// themselves as `Twitterbot` and `WhatsApp/2.x`, so match those exact shapes.

// Generic: "…Bot/1.0", "…bot;", "…bot)", "Slackbot-LinkExpanding" or a UA
// ending in "bot", plus the crawler/spider families. The delimiter guard keeps
// device names that merely contain the letters from reading as bots — hence no
// "_", which is exactly how Android's "CUBOT_NOTE_20" spells it.
const GENERIC_BOT = /bot[-/\s;),]|bot$|crawler|crawling|spider/i;

// Named fetchers that don't say "bot": preview scrapers, AI/search crawlers,
// headless browsers, uptime monitors, and bare HTTP clients.
const NAMED_BOT = new RegExp([
  // Link-preview / social
  "facebookexternalhit", "facebookcatalog", "facebot", "slack-imgproxy",
  "skypeuripreview", "whatsapp/", "pinterest/", "vkshare", "embedly",
  "iframely", "quora link", "nuzzel", "outbrain", "flipboard",
  // Search / AI crawlers that don't match GENERIC_BOT
  "google-inspectiontool", "google-extended", "baiduspider", "slurp",
  "applebot", "ahrefs", "semrush", "mj12", "bytespider",
  // Headless browsers + perf tooling
  "headlesschrome", "phantomjs", "puppeteer", "playwright", "lighthouse",
  // Uptime monitors
  "uptimerobot", "pingdom", "statuscake", "site24x7", "newrelicpinger",
  // Bare HTTP clients
  "curl/", "wget/", "python-requests", "python-urllib", "node-fetch",
  "go-http-client", "axios/", "okhttp", "java/", "postmanruntime",
  "libwww-perl", "httpclient", "guzzle", "apache-httpclient",
].join("|"), "i");

// An absent User-Agent counts as a bot: every real browser sends one, so a
// missing header means a script. Under-counting a hypothetical stripped header
// is the safer error than inflating counts shown to buyers as social proof.
function isBot(ua) {
  const s = String(ua || "").trim();
  if (!s) return true;
  return GENERIC_BOT.test(s) || NAMED_BOT.test(s);
}

module.exports = { isBot };
