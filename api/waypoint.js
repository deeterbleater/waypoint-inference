const DEFAULT_ENDPOINT = "https://icg2ierx8uoi66-19123.proxy.runpod.net";

function sendJson(res, status, payload) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).send(JSON.stringify(payload));
}

function upstreamUrl(path) {
  const base = (process.env.WAYPOINT_ENDPOINT_BASE || DEFAULT_ENDPOINT).replace(/\/$/, "");
  return `${base}${path}`;
}

export default async function handler(req, res) {
  const action = String(req.query.action || "");
  if (!["health", "generate", "reset"].includes(action)) {
    sendJson(res, 404, { ok: false, error: "unknown action" });
    return;
  }

  const path = `/${action}`;
  const method = action === "health" ? "GET" : "POST";
  const headers = { "Content-Type": "application/json" };
  const apiKey = process.env.WAYPOINT_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const upstream = await fetch(upstreamUrl(path), {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(req.body || {}) : undefined,
      signal: AbortSignal.timeout(action === "generate" ? 90000 : 15000),
    });

    const text = await upstream.text();
    res.setHeader("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.status(upstream.status).send(text);
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      error: error instanceof Error ? error.message : "upstream request failed",
    });
  }
}
