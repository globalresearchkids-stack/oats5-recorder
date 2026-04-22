/**
 * oats5-recorder — Updated recorder entry script
 * 
 * KEY CHANGE: Instead of reading livekit_token from the DB tags,
 * the recorder now calls the get-livekit-token edge function directly
 * using the service role key. This makes it independent of manage-recording
 * and uses the proven, static-import token minting path.
 * 
 * Required environment variables (set as GitHub Actions secrets):
 *   SUPABASE_URL          - e.g. https://dkhglomszvuomthtslij.supabase.co
 *   SUPABASE_SERVICE_KEY  - The service_role key for the Singapore project
 *   AWS_ACCESS_KEY_ID     - For S3 upload
 *   AWS_SECRET_ACCESS_KEY - For S3 upload
 *   S3_BUCKET             - e.g. oats-recordings
 *   S3_REGION             - e.g. ap-southeast-1
 * 
 * Inputs from GitHub Actions dispatch (client_payload):
 *   room_name     - The LiveKit room name (timetable session UUID)
 *   recording_id  - The class_recordings row ID
 *   app_base_url  - e.g. https://oats5.com
 *   supabase_url  - The Supabase URL (also available from env)
 */

const puppeteer = require('puppeteer');
const { launch, getStream } = require('puppeteer-stream');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

// ── Configuration ──
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://oats5.com';

const ROOM_NAME = process.env.ROOM_NAME;
const RECORDING_ID = process.env.RECORDING_ID;

const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const S3_BUCKET = process.env.S3_BUCKET || 'oats-recordings';
const S3_REGION = process.env.S3_REGION || 'ap-southeast-1';

function log(...args) {
  console.log(`[recorder ${new Date().toISOString()}]`, ...args);
}

function fatal(...args) {
  console.error(`[recorder ${new Date().toISOString()}] FATAL:`, ...args);
  process.exit(1);
}

async function main() {
  // ── Validate inputs ──
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    fatal('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  }
  if (!ROOM_NAME || !RECORDING_ID) {
    fatal('Missing ROOM_NAME or RECORDING_ID from dispatch payload');
  }

  log('Starting recorder for room:', ROOM_NAME, 'recording:', RECORDING_ID);
  log('Backend:', SUPABASE_URL.replace(/https:\/\/(.{8}).*/, 'https://$1***...'));
  log('App:', APP_BASE_URL);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── Step 1: Fetch LiveKit token from get-livekit-token edge function ──
  log('Fetching LiveKit token from get-livekit-token edge function…');

  const tokenRes = await fetch(`${SUPABASE_URL}/functions/v1/get-livekit-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      roomName: ROOM_NAME,
      identity: 'recorder-bot',
      participantName: 'Recorder Bot',
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    // Update recording status to failed with the error detail
    await supabase
      .from('class_recordings')
      .update({
        status: 'failed',
        tags: {
          token_fetch_error: `HTTP ${tokenRes.status}: ${errText.slice(0, 500)}`,
          failed_at: new Date().toISOString(),
        },
      })
      .eq('id', RECORDING_ID);
    fatal(`Failed to fetch LiveKit token: HTTP ${tokenRes.status} — ${errText.slice(0, 300)}`);
  }

  const tokenData = await tokenRes.json();

  if (!tokenData.token || !tokenData.url) {
    await supabase
      .from('class_recordings')
      .update({
        status: 'failed',
        tags: {
          token_fetch_error: `Missing token/url in response. Keys: ${Object.keys(tokenData).join(', ')}`,
          failed_at: new Date().toISOString(),
        },
      })
      .eq('id', RECORDING_ID);
    fatal('Invalid token response:', JSON.stringify(tokenData));
  }

  const LK_TOKEN = tokenData.token;
  const LK_URL = tokenData.url;
  log('✅ Got LiveKit token (length:', LK_TOKEN.length, ') and URL:', LK_URL);

  // ── Step 2: Update recording status to 'recording' ──
  await supabase
    .from('class_recordings')
    .update({ status: 'recording' })
    .eq('id', RECORDING_ID);

  // ── Step 3: Launch browser and open RecorderBot page ──
  const recorderUrl = `${APP_BASE_URL}/recorder/${ROOM_NAME}?token=${encodeURIComponent(LK_TOKEN)}&url=${encodeURIComponent(LK_URL)}`;
  log('Opening recorder page:', recorderUrl.replace(/token=[^&]+/, 'token=***'));

  const browser = await launch({
    executablePath: puppeteer.executablePath(),
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const page = await browser.newPage();
  await page.goto(recorderUrl, { waitUntil: 'networkidle2', timeout: 30000 });

  // Wait for the recorder to connect to the LiveKit room
  log('Waiting for LiveKit room connection…');
  await page.waitForSelector('[data-recorder-connected="true"]', { timeout: 30000 });
  log('✅ Connected to LiveKit room');

  // ── Step 4: Start recording ──
  const outputPath = path.join('/tmp', `${RECORDING_ID}.webm`);
  const stream = await getStream(page, { audio: true, video: true });

  const fileStream = fs.createWriteStream(outputPath);
  stream.pipe(fileStream);
  log('Recording started → ', outputPath);

  // ── Step 5: Poll for stop signal ──
  const POLL_INTERVAL = 10000; // 10 seconds
  const MAX_DURATION = 4 * 60 * 60 * 1000; // 4 hours max
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_DURATION) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    const { data: rec } = await supabase
      .from('class_recordings')
      .select('status')
      .eq('id', RECORDING_ID)
      .maybeSingle();

    if (rec?.status === 'stopping' || rec?.status === 'failed') {
      log('Stop signal received, status:', rec.status);
      break;
    }
  }

  // ── Step 6: Stop recording ──
  stream.destroy();
  await new Promise(r => fileStream.on('finish', r));
  log('Recording stopped');

  await browser.close();

  // ── Step 7: Upload to S3 ──
  const fileBuffer = fs.readFileSync(outputPath);
  const s3Key = `${ROOM_NAME}/${RECORDING_ID}.webm`;

  log('Uploading to S3:', s3Key, '(', fileBuffer.length, 'bytes)');

  const s3 = new S3Client({
    region: S3_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  });

  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    Body: fileBuffer,
    ContentType: 'video/webm',
  }));

  log('✅ Uploaded to S3');

  // ── Step 8: Finalize recording via edge function ──
  const finalizeRes = await fetch(`${SUPABASE_URL}/functions/v1/finalize-recording`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      recording_id: RECORDING_ID,
      s3_key: s3Key,
      action: 'completed',
    }),
  });

  if (finalizeRes.ok) {
    log('✅ Recording finalized successfully');
  } else {
    const errText = await finalizeRes.text();
    log('⚠️ Finalize call returned:', finalizeRes.status, errText);
  }

  // Cleanup
  fs.unlinkSync(outputPath);
  log('Done.');
}

main().catch(err => {
  console.error('[recorder] Unhandled error:', err);
  process.exit(1);
});
