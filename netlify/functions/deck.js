// Short redirect for Deal Deck PDFs: /deck/<slug> -> the public PDF in Storage.
// Keeps SMS links short and branded (seaside-dispo-app.netlify.app/deck/<addr>)
// instead of exposing the long Supabase Storage URL.
const SB_URL = process.env.SUPABASE_URL;

exports.handler = async (event) => {
  const raw = (event.queryStringParameters && event.queryStringParameters.slug) || "";
  const slug = raw.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!slug || !SB_URL) return { statusCode: 404, body: "Deal deck not found" };
  const url = `${SB_URL}/storage/v1/object/public/property-photos/deal-decks/${slug}.pdf`;
  return { statusCode: 302, headers: { Location: url }, body: "" };
};
