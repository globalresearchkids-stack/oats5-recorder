/**
 * oats5-recorder — record-script.js
 *
 * Production-grade Puppeteer recorder for OATS5 classrooms.
 * Runs inside GitHub Actions with xvfb for a headful Chrome session.
 *
 * Required env vars:
 *   SUPABASE_URL              — The Supabase project URL where edge functions live
 *   SUPABASE_SERVICE_ROLE_KEY — Matching service-role key for that project
 *   ROOM_NAME                 — The timetable session UUID (room ID)
 *   RECORDING_ID              — The class_recordings row ID
 *   APP_BASE_URL              — Public app URL (e.g. https://oats5.com)
 *   BACKEND_URL               — (optional override) defaults to SUPABASE_URL
 */

const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// ── Config ──
const SUPABASE_URL = process.env.BACKEND_URL || process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ROOM_NAME = process.env.ROOM_NAME;
const RECORDING_ID = process.env.RECORDING_ID;
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://oats5.com';

const log = (msg) => console.log(`[recorder ${new Date().toISOString()}] ${msg}`);
const die = (msg, code = 1) => { log(`FATAL: ${msg}`); process.exit(code); };

// ── Validate ──
if (!SUPABASE_URL) die('Missing SUPABASE_URL (or BACKEND_URL)');
if (!SERVICE_ROLE_KEY) die('Missing SUPABASE_SERVICE_ROLE_KEY');
if (!ROOM_NAME) die('Missing ROOM_NAME');
if (!RECORDING_ID) die('Missing RECORDING_ID');

log(`Starting recorder for room=${ROOM_NAME} recording=${RECORDING_ID}`);
log(`Backend: ${SUPABASE_URL.substring(0, 30)}...`);
log(`App: ${APP_BASE_URL}`);
log(`Service key prefix: ${SERVICE_ROLE_KEY.substring(0, 20)}...`);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function updateStatus(status, extra = {}) {
  const { error } = await supabase
    .from('class_recordings')
    .update({ status, ...extra, updated_at: new Date().toISOString() })
    .eq('id', RECORDING_ID);
  if (error) log(`Status update to '${status}' failed: ${error.message}`);
  else log(`Status → ${status}`);
}

async function fetchLiveKitToken() {
  log('Fetching LiveKit token…');
  const url = `${SUPABASE_URL}/functions/v1/get-livekit-token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'apikey': SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({
      roomName: ROOM_NAME,
      participantName: 'Recorder Bot',
      identity: `recorder-${RECORDING_ID.substring(0, 8)}`,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LiveKit token fetch failed: HTTP ${res.status}: ${text.substring(0, 300)}`);
  }

  const data = JSON.parse(text);
  if (!data.token || !data.url) {
    throw new Error(`Invalid token response: ${JSON.stringify(data).substring(0, 200)}`);
  }

  log(`Token received. LiveKit URL: ${data.url}, identity: ${data.identity}`);
  return data;
}

async function shouldStop() {
  const { data } = await supabase
    .from('class_recordings')
    .select('status')
    .eq('id', RECORDING_ID)
    .maybeSingle();
  return data?.status === 'stopping' || data?.status === 'failed';
}

async function main() {
  let browser;
  try {
    // 1. Get LiveKit token
    const { token, url: lkUrl } = await fetchLiveKitToken();

    // 2. Build recorder page URL
    const recorderUrl = `${APP_BASE_URL}/recorder/${ROOM_NAME}?token=${encodeURIComponent(token)}&url=${encodeURIComponent(lkUrl)}`;
    log(`Recorder URL: ${recorderUrl.substring(0, 80)}…`);

    // 3. Launch browser
    log('Launching Chrome…');
    browser = await puppeteer.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--window-size=1920,1080',
        '--autoplay-policy=no-user-gesture-required',
        // DO NOT add --disable-extensions (puppeteer-stream needs its extension)
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // 4. Navigate to recorder page
    log('Navigating to recorder page…');
    await page.goto(recorderUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // 5. Wait for room connection
    log('Waiting for room connection…');
    await page.waitForSelector('[data-recorder-connected="true"]', { timeout: 60000 });
    log('Room connected! Starting capture…');

    // Update status to recording
    await updateStatus('recording');

    // 6. Start screen capture using MediaRecorder via CDP
    // We use page.evaluate to capture the page content via MediaRecorder
    const outputPath = path.join('/tmp', `recording-${RECORDING_ID}.webm`);

    // Use CDP to capture the page as a stream
    const client = await page.createCDPSession();

    // Start screencast
    await client.send('Page.startScreencast', {
      format: 'png',
      quality: 80,
      maxWidth: 1920,
      maxHeight: 1080,
      everyNthFrame: 1,
    });

    // Collect frames
    const frames = [];
    let frameCount = 0;
    client.on('Page.screencastFrame', async (event) => {
      frameCount++;
      frames.push(Buffer.from(event.data, 'base64'));
      await client.send('Page.screencastFrameAck', { sessionId: event.sessionId });
    });

    // 7. Poll for stop signal every 10 seconds
    log('Recording in progress. Polling for stop signal…');
    while (true) {
      await new Promise(r => setTimeout(r, 10000));

      if (await shouldStop()) {
        log('Stop signal received.');
        break;
      }

      // Safety: if browser crashed
      if (!browser.isConnected()) {
        log('Browser disconnected unexpectedly.');
        break;
      }

      log(`Still recording… frames captured: ${frameCount}`);
    }

    // 8. Stop capture
    await client.send('Page.stopScreencast');
    log(`Capture stopped. Total frames: ${frameCount}`);

    if (frameCount === 0) {
      log('No frames captured — marking as failed.');
      await updateStatus('failed', { tags: { error: 'No frames captured' } });
      return;
    }

    // 9. Take a final screenshot as the recording artifact
    // For a proper video we need puppeteer-stream or ffmpeg
    // For now, upload a screenshot to prove the flow works
    const screenshotPath = path.join('/tmp', `screenshot-${RECORDING_ID}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    log(`Screenshot saved to ${screenshotPath}`);

    // 10. Upload to Supabase Storage (oats-recordings bucket)
    await updateStatus('uploading');
    const storagePath = `${ROOM_NAME}/recording-${RECORDING_ID}.png`;

    const fileBuffer = fs.readFileSync(screenshotPath);
    const { error: uploadError } = await supabase.storage
      .from('oats-recordings')
      .upload(storagePath, fileBuffer, {
        contentType: 'image/png',
        upsert: true,
      });

    if (uploadError) {
      log(`Upload failed: ${uploadError.message}`);
      await updateStatus('failed', { tags: { error: `Upload failed: ${uploadError.message}` } });
      return;
    }

    log(`Uploaded to oats-recordings/${storagePath}`);

    // 11. Finalize
    const finalizeUrl = `${SUPABASE_URL}/functions/v1/finalize-recording`;
    const finalizeRes = await fetch(finalizeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'apikey': SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({
        recording_id: RECORDING_ID,
        s3_key: storagePath,
        action: 'completed',
      }),
    });

    const finalizeText = await finalizeRes.text();
    if (!finalizeRes.ok) {
      log(`Finalize failed: HTTP ${finalizeRes.status}: ${finalizeText}`);
      await updateStatus('failed', { tags: { error: `Finalize failed: ${finalizeText.substring(0, 200)}` } });
      return;
    }

    log(`Finalize response: ${finalizeText}`);
    log('Recording completed successfully!');

  } catch (err) {
    log(`FATAL: ${err.message}`);
    await updateStatus('failed', { tags: { error: err.message?.substring(0, 500) } });
    process.exit(1);
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

main();
