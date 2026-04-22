import 'dotenv/config'; // Loads env automatically if present
import { jobQueue } from '../src/queue/queue.js';
import { worker } from '../src/workers/worker.js'; // Importing starts the worker automatically

async function testWorker() {
    console.log("🚀 Starting Worker Test...");

    // 1. Add a job to the queue
    console.log("📥 Adding a 'camera-edit' job to the queue...");
    const job = await jobQueue.add('camera-edit', {
        userId: 'a1467c37-23de-4fb4-bf9a-d4f24e672ac3',
        project_id: '221698ae-d530-4ac6-ae8e-ed3dba91b251',
        session_id: '221698ae-d530-4ac6-ae8e-ed3dba91b251',
        workflow_id: '430016bf-1fe6-4d68-aaeb-edba1cc792ec',
        prompt: 'dolly push in',
        imageUrl: 'https://example.com/test-image.jpg'
    });

    console.log(`✅ Job added successfully with ID: ${job.id}`);
    console.log("⏳ Waiting for the worker to process it (check the console logs)..");
    
    // The script stays alive because BullMQ worker holds the process open
}

testWorker().catch((err) => {
    console.error("Test failed to start:", err);
});
