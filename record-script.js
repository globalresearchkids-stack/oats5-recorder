const puppeteer = require('puppeteer');
const { launch, getStream } = require('puppeteer-stream');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { AccessToken } = require('livekit-server-sdk');
const fs = require('fs');
const path = require('path');

// ── Configuration ──
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL;
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
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) fatal('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) fatal('Missing LIVEKIT_API_KEY, LIVEKIT_API_SECRET, or LIVEKIT_URL');
  if (!ROOM_NAME || !RECORDING_ID) fatal('Missing ROOM_NAME or RECORDING_ID from dispatch payload');

  log('Starting recorder for room:', ROOM_NAME, 'recording:', RECORDING_ID);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── Step 1: Generate LiveKit token ──
  log('Generating LiveKit token locally…');
  
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: `recorder-${RECORDING_ID.substring(0, 8)}`,
  });
  at.addGrant({
    roomJoin: true,
    room: ROOM_NAME,
    canPublish: false,
    canSubscribe: true,
  });
  const LK_TOKEN = await at.toJwt();
  const LK_URL = LIVEKIT_URL;
  log('✅ Generated LiveKit token locally');

  // ── Step 2: Update recording status ──
  await supabase.from('class_recordings').update({ status: 'recording' }).eq('id', RECORDING_ID);

  // ── Step 3: Launch browser ──
  const recorderUrl = `${APP_BASE_URL}/recorder/${ROOM_NAME}?token=${encodeURIComponent(LK_TOKEN)}&url=${encodeURIComponent(LK_URL)}`;
  
  const browser = await launch({
    executablePath: puppeteer.executablePath(),
    headless: false, // FIXED: Must be false for puppeteer-stream extension to work
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
  const POLL_INTERVAL = 10000;
  const MAX_DURATION = 4 * 60 * 60 * 1000;
  const startTime = Date.now();
  let stopRequested = false;

  process.on('SIGTERM', () => {
    stopRequested = true;
    log('SIGTERM received, requesting stop');
  });

  process.on('SIGINT', () => {
    stopRequested = true;
    log('SIGINT received, requesting stop');
  });

  while (Date.now() - startTime < MAX_DURATION && !stopRequested) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    const { data: rec } = await supabase.from('class_recordings').select('status').eq('id', RECORDING_ID).maybeSingle();
    if (rec?.status === 'stopping' || rec?.status === 'failed') {
      log('Stop signal received, status:', rec.status);
      break;
    }
    if (stopRequested) {
      log('Stop requested via signal');
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

  log('Uploading to S3...');
  const s3 = new S3Client({
    region: S3_REGION,
    credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
  });

  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    Body: fileBuffer,
    ContentType: 'video/webm',
  }));
  log('✅ Uploaded to S3');

  // ── Step 8: Finalize ──
  const recordingUrl = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${encodeURIComponent(s3Key)}`;
  const endedAt = new Date().toISOString();
  const durationSeconds = Math.floor((Date.now() - startTime) / 1000);

  await supabase.from('class_recordings').update({
    status: 'completed',
    recording_url: recordingUrl,
    ended_at: endedAt,
    duration_seconds: durationSeconds,
  }).eq('id', RECORDING_ID);
  log('✅ Recording finalized successfully');

  fs.unlinkSync(outputPath);
  log('Done.');
}

main().catch(err => {
  console.error('[recorder] Unhandled error:', err);
  process.exit(1);
});
