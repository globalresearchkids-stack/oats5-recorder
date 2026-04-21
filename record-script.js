const { launch, getStream } = require('puppeteer-stream');
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

async function record() {
    // Launch browser in "headful" mode but inside the Xvfb environment
    const browser = await launch({
        executablePath: '/usr/bin/google-chrome',
        defaultViewport: { width: 1920, height: 1080 },
        headless: false, // Must be false for puppeteer-stream to capture properly
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--use-fake-ui-for-media-stream',
            '--disable-extensions'
        ]
    });

    const page = await browser.newPage();
    const roomUrl = process.env.ROOM_URL;
    const recordingId = process.env.RECORDING_ID;
    const fileName = `oats5-recording-${recordingId}.webm`;

    console.log(`Joining Oats5 room: ${roomUrl}`);
    
    // We navigate to the room. 
    // Tip: Make sure your classroom page doesn't show a "Join" button 
    // for this bot, or script a click here!
    await page.goto(roomUrl, { waitUntil: 'networkidle2' });

    // Start Capturing
    const stream = await getStream(page, { audio: true, video: true, frameRate: 30 });
    console.log("Recording started...");

    // Modern AWS S3 V3 Client
    const s3Client = new S3Client({ region: process.env.AWS_REGION });

    const upload = new Upload({
        client: s3Client,
        params: {
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: fileName,
            Body: stream,
            ContentType: 'video/webm'
        }
    });

    try {
        console.log("Streaming to S3...");
        await upload.done();
        console.log("Upload complete!");

        // Update Supabase
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
        console.log("Database updated.");

    } catch (e) {
        console.error("Pipeline error:", e);
    }

    await browser.close();
}

record();
