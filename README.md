# Waypoint Inference Portal

Browser portal for the RunPod-hosted `Overworld/Waypoint-1.5-1B` endpoint.

## Local

```bash
npm install
npm run dev
```

The portal password is hardcoded in `src/main.tsx`.

## Vercel Env

Set these on the Vercel project:

```bash
WAYPOINT_API_KEY=...
WAYPOINT_ENDPOINT_BASE=https://icg2ierx8uoi66-19123.proxy.runpod.net
```

The browser never receives `WAYPOINT_API_KEY`; requests go through
`api/waypoint.js`.

`Start Drive` uses `/api/waypoint?action=stream` to receive NDJSON frame events
from the RunPod endpoint and sends the current controls on each step. The stream
requests JPEG output and updates the live viewport once per received frame.
Each drive captures its streamed frames in the browser; after stopping, use
`Export Drive Video` to render the captured frames into a downloadable MP4 when
the browser supports MP4 recording.
