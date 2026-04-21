const { launch, getStream } = require('puppeteer-stream');
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

async function record() {
    const browser = await launch({
        executablePath: '/usr/bin/google-chrome',
        defaultViewport: { width: 1920, height: 1080 },
        headless: false, 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--use-fake-ui-for-media-stream',
            // REMOVED: --disable-extensions (This was the cause of the error)
            '--allow-http-screen-capture',
            '--allow-sandbox-debugging',
            '--disable-dev-shm-usage',
            '--disable-gpu' // Helps stability in headless environments like GitHub
        ]
    });

    const page = await browser.newPage();
    const roomUrl = process.env.ROOM_URL;
    const recordingId = process.env.RECORDING_ID;
    const fileName = `oats5-recording-${recordingId}.webm`;

    // Increased timeout for slow GitHub runner networking
    page.setDefaultNavigationTimeout(60000); 

    try {
        console.log(`Joining Oats5 room: ${roomUrl}`);
        await page.goto(roomUrl, { waitUntil: 'networkidle2' });

        // Give the page 3 seconds to fully settle/load 3D assets before starting capture
        await new Promise(r => setTimeout(r, 3000));

        const stream = await getStream(page, { audio: true, video: true, frameRate: 30 });
        console.log("Recording started...");

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

        console.log("Streaming to S3...");
        await upload.done();
        console.log("Upload complete!");

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
        console.error("Critical Error:", e.message);
        // If it fails, still try to close browser to free up GitHub runner
    } finally {
        await browser.close();
    }
}

record();
