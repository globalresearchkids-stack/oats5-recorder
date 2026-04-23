# Oats5 Cloud Recorder

Puppeteer-based recording bot for Oats5 live classroom sessions.
Runs as a GitHub Actions workflow, triggered by the Oats5 app.

## Architecture

```
┌─────────────┐  dispatch   ┌──────────────┐  generate token ┌────────────────┐
│  Oats5 App  │────────────▶│ GitHub Action │────────────────▶│ LiveKit Server │
│ (teacher    │              │  (recorder)  │                 │                 │
│  joins)     │              │              │◀────────────────│                 │
└─────────────┘              │              │  LK JWT         └────────────────┘
                             │              │
                             │  puppeteer   │  navigate     ┌────────────────┐
                             │  -stream     │──────────────▶│ /recorder/:id  │
                             │              │               │ (minimal page) │
                             │              │               └────────────────┘
                             │              │
                             │  upload      │               ┌────────────────┐
                             │  .webm       │──────────────▶│ oats-recordings│
                             │              │               │ (Supabase      │
                             │  finalize    │               │  Storage)      │
                             │              │──────────────▶│                │
                             └──────────────┘               └────────────────┘
```

## How It Works

1. Teacher joins a live classroom → app dispatches `start-recording` to this repo
2. GitHub Actions runs `record-script.js` inside `xvfb-run` (virtual display)
3. Script generates a LiveKit token locally using the API key and secret
4. Opens Chrome, navigates to `/recorder/:roomId?token=...&url=...`
5. Waits for `[data-recorder-connected]` attribute (room is live)
6. Captures the tab with `puppeteer-stream` → writes `.webm` to disk
7. Polls `class_recordings.status` every 10s for `stopping` signal
8. On stop: uploads `.webm` to `oats-recordings` Supabase Storage bucket
9. Updates DB row to `completed` with S3 key

## Stop Flow

The recording stops when:
- The app dispatches `stop-recording` → GitHub Actions sets status to `stopping`
- The last teacher leaves → app sets status to `stopping`
- The 4-hour hard cap is reached
- The GitHub Actions job times out (5 hours)

The bot polls the database for the `stopping` signal.

## Required GitHub Secrets

| Secret | Description |
|--------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key for the Supabase project |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |
| `LIVEKIT_URL` | LiveKit server URL (e.g., `https://your-livekit-server.livekit.cloud`) |
| `AWS_ACCESS_KEY_ID` | AWS access key for S3 upload |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key for S3 upload |
| `AWS_BUCKET_NAME` | S3 bucket name for recordings |
| `S3_REGION` | AWS region for S3 bucket |

## Local Testing

```bash
npm install

export ROOM_NAME="your-timetable-session-uuid"
export RECORDING_ID="your-class-recordings-row-id"
export SUPABASE_URL="x"
export SUPABASE_SERVICE_ROLE_KEY="your-key"

# Requires Xvfb on Linux, or a display on macOS
xvfb-run --auto-servernum node record-script.js
```

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Missing X server` | No virtual display | Ensure `xvfb-run` wraps the command |
| `ERR_BLOCKED_BY_CLIENT` | `--disable-extensions` flag | Do NOT use that flag (puppeteer-stream needs its extension) |
| `LiveKit token generation failed` | Missing or invalid LiveKit secrets | Check `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_URL` secrets |
| `Room connection timeout` | No teacher in the room yet | Bot should only be dispatched after teacher joins |
| `Recording file too small` | Capture didn't start properly | Check Chrome flags and Xvfb resolution |
