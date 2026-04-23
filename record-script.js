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
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) fatal('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  if (!ROOM_NAME || !RECORDING_ID) fatal('Missing ROOM_NAME or RECORDING_ID from dispatch payload');

  log('Starting recorder for room:', ROOM_NAME, 'recording:', RECORDING_ID);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── Step 1: Fetch LiveKit token ──
  log('Fetching LiveKit token from get-livekit-token edge function…');
  
  const tokenRes = await fetch(`${SUPABASE_URL}/functions/v1/get-livekit-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'apikey': SUPABASE_SERVICE_KEY, // FIXED: Added required Supabase apikey header
    },
    body: JSON.stringify({
      roomName: ROOM_NAME,
      participantName: 'Recorder Bot',
      identity: `recorder-${RECORDING_ID.substring(0, 8)}`, // FIXED: Prevents "missing sub claim" error
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    await supabase.from('class_recordings').update({
      status: 'failed',
      tags: { token_fetch_error: `HTTP ${tokenRes.status}: ${errText.slice(0, 500)}` },
    }).eq('id', RECORDING_ID);
    fatal(`Failed to fetch LiveKit token: HTTP ${tokenRes.status} — ${errText.slice(0, 300)}`);
  }

  const tokenData = await tokenRes.json();
  if (!tokenData.token || !tokenData.url) fatal('Invalid token response:', JSON.stringify(tokenData));

  const LK_TOKEN = tokenData.token;
  const LK_URL = tokenData.url;
  log('✅ Got LiveKit token');

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

  while (Date.now() - startTime < MAX_DURATION) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    const { data: rec } = await supabase.from('class_recordings').select('status').eq('id', RECORDING_ID).maybeSingle();
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
  const finalizeRes = await fetch(`${SUPABASE_URL}/functions/v1/finalize-recording`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'apikey': SUPABASE_SERVICE_KEY
    },
    body: JSON.stringify({ recording_id: RECORDING_ID, s3_key: s3Key, action: 'completed' }),
  });

  if (finalizeRes.ok) log('✅ Recording finalized successfully');
  else log('⚠️ Finalize call returned:', finalizeRes.status, await finalizeRes.text());

  fs.unlinkSync(outputPath);
  log('Done.');
}

main().catch(err => {
  console.error('[recorder] Unhandled error:', err);
  process.exit(1);
});
