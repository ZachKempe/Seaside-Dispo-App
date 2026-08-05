// Tests for lib/bot-ua.js — the filter that keeps link-preview scrapers out of
// `deck_views`. Both directions cost real money: a false negative inflates the
// "N people viewed this in 24h" line buyers see on the deck page and the
// dashboard's follow-up nudges, while a false positive silently drops a real
// investor's view — including the ones that drive the "Call today" strip. The
// in-app-browser cases below are the ones a naive /twitter/i would break.
// Run with: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { isBot } = require("../netlify/functions/lib/bot-ua");

// ── Real people ───────────────────────────────────────────────────
test("isBot passes ordinary mobile and desktop browsers", () => {
  const humans = [
    // iPhone Safari — the single most common deck visitor
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    // Android Chrome
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    // Desktop Chrome / Firefox / Edge
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  ];
  for (const ua of humans) assert.equal(isBot(ua), false, ua);
});

test("isBot passes in-app browsers whose UA carries the app's brand name", () => {
  // These are people who tapped a forwarded link inside the app. Matching the
  // brand name instead of the fetcher token would drop every one of them.
  const inApp = [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/468.0.0.0]",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone",
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 Instagram 340.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 LinkedInApp",
  ];
  for (const ua of inApp) assert.equal(isBot(ua), false, ua);
});

test("isBot does not mistake a device name containing 'bot' for a crawler", () => {
  // CUBOT is a real Android phone brand — the classic /bot/i false positive.
  assert.equal(isBot("Mozilla/5.0 (Linux; Android 11; CUBOT_NOTE_20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.0.0 Mobile Safari/537.36"), false);
});

// ── Link-preview scrapers ─────────────────────────────────────────
test("isBot catches the preview scrapers that unfurl a forwarded deck link", () => {
  const scrapers = [
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "Mozilla/5.0 (compatible; Twitterbot/1.0)",
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "Slackbot 1.0 (+https://api.slack.com/robots)",
    "WhatsApp/2.23.20.0 A",
    "TelegramBot (like TwitterBot)",
    "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
    "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
    "SkypeUriPreview Preview/0.5",
    "Mozilla/5.0 (compatible; redditbot/1.0; +http://www.reddit.com/feedback)",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
    "Embedly/1.0",
    "Mozilla/5.0 (compatible; Pinterest/0.2; +http://www.pinterest.com/bot.html)",
  ];
  for (const ua of scrapers) assert.equal(isBot(ua), true, ua);
});

test("isBot catches search, AI, SEO and headless crawlers", () => {
  const crawlers = [
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "Mozilla/5.0 (compatible; YandexBot/3.0)",
    "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)",
    "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
    "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36",
  ];
  for (const ua of crawlers) assert.equal(isBot(ua), true, ua);
});

test("isBot catches bare HTTP clients and uptime monitors", () => {
  const clients = [
    "curl/8.4.0",
    "Wget/1.21.4",
    "python-requests/2.31.0",
    "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
    "Go-http-client/2.0",
    "axios/1.6.8",
    "PostmanRuntime/7.37.3",
    "Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)",
  ];
  for (const ua of clients) assert.equal(isBot(ua), true, ua);
});

// ── Missing / garbage ─────────────────────────────────────────────
test("isBot treats an absent or empty User-Agent as a bot", () => {
  // Every real browser sends one; an absent header means a script.
  assert.equal(isBot(""), true);
  assert.equal(isBot("   "), true);
  assert.equal(isBot(null), true);
  assert.equal(isBot(undefined), true);
});
