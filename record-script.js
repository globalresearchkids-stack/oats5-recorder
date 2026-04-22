/**
 * Oats5 Cloud Recorder — Puppeteer-based session capture
 *
 * Flow:
 *  1. Get a LiveKit token from the edge function (service-role auth)
 *  2. Launch headful Chrome inside Xvfb
 *  3. Navigate to /recorder/:roomId?token=...&url=...
 *  4. Wait for [data-recorder-connected] attribute (room connected)
 *  5. Start capturing with puppeteer-stream → write to temp file
 *  6. Poll class_recordings.status every 10s for "stopping" signal
 *  7. On stop: end capture, upload .webm to oats-recordings bucket, finalize DB
 *
 * Environment variables (set by GitHub Actions):
 *  - ROOM_NAME           — timetable session UUID (used as LiveKit room name)
 *  - RECORDING_ID        — class_recordings row ID
 *  - SUPABASE_URL        — https://dkhglomszvuomthtslij.supabase.co
 *  - SUPABASE_SERVICE_ROLE_KEY
 */

const { launch, getStream } = require('puppeteer-stream');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────
const ROOM_NAME    = process.env.ROOM_NAME;
const RECORDING_ID = process.env.RECORDING_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const APP_ORIGIN     = 'https://oats5.com';
const STOP_POLL_MS   = 10_000;          // Poll DB every 10 seconds
const MAX_DURATION   = 4 * 3600_000;    // 4 hour hard cap
const SETTLE_DELAY   = 5_000;           // Wait after room connected before capture
const NAV_TIMEOUT    = 90_000;          // Page navigation timeout
const CONNECT_TIMEOUT = 60_000;         // Room connection timeout

// ── Helpers ─────────────────────────────────────────────────────────────────
const log = (...args) => console.log(`[recorder ${new Date().toISOString()}]`, ...args);
const err = (...args) => console.error(`[recorder ${new Date().toISOString()}]`, ...args);

function validateEnv() {
  const missing = [];
  if (!ROOM_NAME)    missing.push('ROOM_NAME');
  if (!RECORDING_ID) missing.push('RECORDING_ID');
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SERVICE_KEY)  missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}

async function updateStatus(supabase, status, extra = {}) {
  const { error } = await supabase
    .from('class_recordings')
    .update({ status, updated_at: new Date().toISOString(), ...extra })
    .eq('id', RECORDING_ID);
  if (error) err(`Failed to update status to ${status}:`, error.message);
  else log(`Status → ${status}`);
}

async function failAndExit(supabase, reason) {
  err('FATAL:', reason);
  await updateStatus(supabase, 'failed', {
    ended_at: new Date().toISOString(),
    tags: { failure_reason: reason },
  });
  process.exit(1);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function record() {
  validateEnv();

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  log(`Starting recorder for room=${ROOM_NAME} recording=${RECORDING_ID}`);

  // ── Step 1: Get LiveKit token ──
  log('Fetching LiveKit token…');
  let lkToken, lkUrl;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/get-livekit-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({
        roomName: ROOM_NAME,
        participantName: 'Recorder Bot',
        identity: `recorder-${RECORDING_ID.slice(0, 8)}`,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    if (!data.token || !data.url) {
      throw new Error(`Invalid response: ${JSON.stringify(data).slice(0, 200)}`);
    }
    lkToken = data.token;
    lkUrl   = data.url;
    log(`LiveKit token acquired. Server: ${lkUrl}`);
  } catch (e) {
    await failAndExit(supabase, `LiveKit token fetch failed: ${e.message}`);
  }

  // ── Step 2: Launch browser ──
  log('Launching Chrome…');
  let browser;
  try {
    browser = await launch({
      executablePath: '/usr/bin/google-chrome',
      defaultViewport: { width: 1920, height: 1080 },
      headless: false,   // Required for puppeteer-stream (it uses a Chrome extension)
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--use-fake-ui-for-media-stream',          // Auto-accept media permissions
        '--auto-accept-camera-and-microphone-capture',
        '--disable-dev-shm-usage',                 // Use /tmp instead of limited /dev/shm
        '--disable-gpu',                           // Stability in virtual framebuffer
        '--disable-background-timer-throttling',   // Keep timers active in background
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--window-size=1920,1080',
      ],
    });
    log('Chrome launched');
  } catch (e) {
    await failAndExit(supabase, `Chrome launch failed: ${e.message}`);
  }

  let page, stream, fileStream;
  const tempFile = path.join('/tmp', `recording-${RECORDING_ID}.webm`);

  try {
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);

    // ── Step 3: Navigate to recorder page ──
    const recorderUrl =
      `${APP_ORIGIN}/recorder/${ROOM_NAME}` +
      `?token=${encodeURIComponent(lkToken)}` +
      `&url=${encodeURIComponent(lkUrl)}`;

    log(`Navigating to recorder page…`);
    await page.goto(recorderUrl, { waitUntil: 'networkidle2' });
    log('Page loaded');

    // ── Step 4: Wait for room connection ──
    log('Waiting for LiveKit room connection…');
    await page.waitForSelector('[data-recorder-connected="true"]', {
      timeout: CONNECT_TIMEOUT,
    });
    log('Room connected! Settling…');
    await new Promise(r => setTimeout(r, SETTLE_DELAY));

    // ── Step 5: Start capture ──
    log('Starting capture…');
    stream = await getStream(page, { audio: true, video: true, frameRate: 30 });
    fileStream = fs.createWriteStream(tempFile);
    stream.pipe(fileStream);

    await updateStatus(supabase, 'recording');
    log('Capture active');

    // ── Step 6: Poll for stop signal ──
    const startTime = Date.now();
    let running = true;

    while (running) {
      await new Promise(r => setTimeout(r, STOP_POLL_MS));

      // Hard time cap
      if (Date.now() - startTime > MAX_DURATION) {
        log('Maximum recording duration reached');
        running = false;
        break;
      }

      try {
        const { data: rec } = await supabase
          .from('class_recordings')
          .select('status')
          .eq('id', RECORDING_ID)
          .single();

        if (!rec || rec.status === 'stopping' || rec.status === 'stopped' || rec.status === 'failed') {
          log(`Stop signal detected (status: ${rec?.status || 'missing'})`);
          running = false;
        }
      } catch (pollErr) {
        err('Poll error (continuing):', pollErr.message);
      }
    }

    // ── Step 7: Stop capture ──
    log('Stopping capture…');
    stream.destroy();
    await new Promise(resolve => {
      fileStream.on('finish', resolve);
      fileStream.end();
    });

    const stats = fs.statSync(tempFile);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    log(`Capture saved: ${tempFile} (${fileSizeMB} MB)`);

    if (stats.size < 1024) {
      await failAndExit(supabase, 'Recording file too small — capture may have failed');
      return;
    }

    // ── Step 8: Upload to oats-recordings bucket ──
    log('Uploading to storage…');
    await updateStatus(supabase, 'uploading');

    const storagePath = `${ROOM_NAME}/${Date.now()}.webm`;
    const fileBuffer = fs.readFileSync(tempFile);

    const { error: uploadError } = await supabase.storage
      .from('oats-recordings')
      .upload(storagePath, fileBuffer, {
        contentType: 'video/webm',
        upsert: false,
      });

    if (uploadError) {
      await failAndExit(supabase, `Storage upload failed: ${uploadError.message}`);
      return;
    }
    log(`Uploaded: oats-recordings/${storagePath}`);

    // ── Step 9: Finalize via edge function ──
    log('Finalizing recording…');
    const finalizeRes = await fetch(`${SUPABASE_URL}/functions/v1/finalize-recording`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({
        recording_id: RECORDING_ID,
        s3_key: storagePath,
      }),
    });

    if (!finalizeRes.ok) {
      const body = await finalizeRes.text();
      err(`Finalize HTTP ${finalizeRes.status}: ${body.slice(0, 200)}`);
      // Storage file is already uploaded — mark manually as fallback
      await updateStatus(supabase, 'completed', {
        recording_url: storagePath,
        ended_at: new Date().toISOString(),
        duration_seconds: Math.round((Date.now() - startTime) / 1000),
      });
    } else {
      const result = await finalizeRes.json();
      log('Finalize result:', JSON.stringify(result));
    }

    log('Recording complete!');

  } catch (e) {
    err('Unexpected error:', e.message);
    try { await updateStatus(supabase, 'failed', { ended_at: new Date().toISOString(), tags: { error: e.message } }); } catch {}
  } finally {
    // Cleanup
    try { if (stream) stream.destroy(); } catch {}
    try { if (fileStream) fileStream.end(); } catch {}
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch {}
    try { if (browser) await browser.close(); } catch {}
    log('Cleanup done');
  }
}

record().catch(e => {
  console.error('Top-level fatal:', e);
  process.exit(1);
});
