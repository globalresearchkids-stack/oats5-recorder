const puppeteer = require('puppeteer');
const { launch, getStream } = require('puppeteer-stream');
const AWS = require('aws-sdk');

async function record() {
    // Launch headless Chrome
    const browser = await launch({
        executablePath: '/usr/bin/google-chrome',
        defaultViewport: { width: 1920, height: 1080 },
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--use-fake-ui-for-media-stream' // Bypasses the "Allow Microphone/Camera" prompt
        ]
    });

    const page = await browser.newPage();
    const roomUrl = process.env.ROOM_URL;
    const recordingId = process.env.RECORDING_ID;
    const fileName = `lops-recording-${recordingId}.webm`;

    console.log(`Joining Oats5 room: ${roomUrl}`);
    await page.goto(roomUrl, { waitUntil: 'networkidle2' });

    // Start Capturing the Tab
    const stream = await getStream(page, { audio: true, video: true });
    console.log("Recording started...");

    // Setup S3 Upload to your ap-southeast-1 bucket
    const s3 = new AWS.S3({ region: process.env.AWS_REGION });
    const params = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: fileName,
        Body: stream,
        ContentType: 'video/webm'
    };

    // Pipe the video data directly to S3
    try {
        await s3.upload(params).promise();
        console.log("Upload to AWS S3 complete!");

        // Tell Supabase the recording is finalized
        await fetch(`${process.env.SUPABASE_URL}/functions/v1/finalize-recording`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
            },
            body: JSON.stringify({ 
                recording_id: recordingId,
                s3_key: fileName 
            })
        });
        console.log("Supabase LOPS record updated.");

    } catch (e) {
        console.error("Recording pipeline failed:", e);
    }

    await browser.close();
}

record();
