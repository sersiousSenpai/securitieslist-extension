// Shared by the extension, the seed generator (Node) and the edge functions
// (Deno). All three must canonicalize and hash URLs identically, or the
// on-device "1 of N" URL match silently fails.

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_|ref$|src$)/i;

export function canonicalUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "") || "/";
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? "?" + new URLSearchParams(params).toString() : "";
  const port = u.port ? ":" + u.port : "";
  return `${host}${port}${path}${query}`.toLowerCase();
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function urlHash(raw) {
  const c = canonicalUrl(raw);
  return c ? sha256Hex(c) : null;
}
