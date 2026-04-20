import { createTaskManager, RedisManager } from "./TaskManager.js";
import { 
    motionTreatment,
    promptService,
    storageService,
    db,
    elementSheetTreatment,
    lightingTreatment,
    upscaleTreatment,
    cameraTreatment,
    videoTreatment,
    editVideoTreatment,
    IMAGE_MODELS
} from "../../container.js";

// Dedicated Redis-ready treatment for Image Generation (don't use the legacy container one)
import { GenerateImageTreatment } from "../../image/treatments/imagetretmentwithRadis.js";
import { EditImageTreatment } from "../../image/treatments/EditImageTreatment.js";

const imageRedisTreatment = new GenerateImageTreatment({
    promptService,
    storageService,
    db,
    models: IMAGE_MODELS
});

const editImageRedisTreatment = new EditImageTreatment({
    promptService,
    storageService,
    db,
    models: IMAGE_MODELS
});

// ═══════════════════════════════════════════════════════════════════════════════
//  RUNNER MANAGER
//  Routes task.runner → the correct treatment.run(task.data).
//  task.data is the plain prepared object returned by treatment.prepare().
//  Add new runners here as the system grows — nothing else needs to change.
// ═══════════════════════════════════════════════════════════════════════════════

const runnerManager = {
    async run(task) {
        switch (task.runner) {
            case "motion":
                return motionTreatment.run(task.data);

            case "image":
                // task.data = imageRedisTreatment.prepare() output
                return imageRedisTreatment.run(task.data);

            case "image-edit":
                // task.data = editImageRedisTreatment.prepare() output
                return editImageRedisTreatment.run(task.data);

            case "element-sheet":
                // task.data = elementSheetTreatment.prepare() output
                return elementSheetTreatment.run(task.data);

            case "lighting":
                return lightingTreatment.run(task.data);

            case "upscale":
                return upscaleTreatment.run(task.data);

            case "camera":
                return cameraTreatment.run(task.data);

            case "video":
                return videoTreatment.run(task.data);

            case "edit_video":
                return editVideoTreatment.run(task.data);

            // Add future runners here:
            // case "lipsync": return lipsyncTreatment.run(task.data);

            default:
                throw new Error(`[RunnerManager] Unknown runner: "${task.runner}"`);
        }
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
//  SINGLETON STATE
//  Private — access only through getTaskService() / getScheduler().
// ═══════════════════════════════════════════════════════════════════════════════

let _taskService = null;
let _scheduler   = null;

// ═══════════════════════════════════════════════════════════════════════════════
//  INIT  —  call ONCE at server startup, before app.listen()
//
//  What it does:
//    1. Creates Upstash Redis client (singleton)
//    2. Creates TaskService (storage + queue management)
//    3. Creates Scheduler (brain — weighted fairness, concurrency cap)
//    4. Starts Scheduler loop (sleeps until first task arrives)
//
//  Calling it twice is safe — returns the existing instance.
// ═══════════════════════════════════════════════════════════════════════════════

export function initRedisManagement() {
    if (_scheduler) {
        console.log("[RedisManagement] Already initialized — skipping.");
        return { taskService: _taskService, scheduler: _scheduler };
    }

    console.log("[RedisManagement] Initializing...");

    const manager = createTaskManager({
        runner:         runnerManager,
        maxConcurrency: 30,   // max parallel API calls
        proWeight:      3,    // 3 pro picks per cycle
        normalWeight:   1,    // 1 normal pick per cycle
    });

    _taskService = manager.taskService;
    _scheduler   = manager.scheduler;

    _scheduler.start();

    console.log("[RedisManagement] Ready.");
    return { taskService: _taskService, scheduler: _scheduler };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SHUTDOWN  —  call on SIGTERM / SIGINT
//
//  What it does:
//    1. Stops Scheduler (no new tasks picked up)
//    2. Closes Redis connection cleanly
//    3. Resets state (safe to re-init after)
// ═══════════════════════════════════════════════════════════════════════════════

export async function stopRedisManagement() {
    console.log("[RedisManagement] Shutting down...");
    if (_scheduler) _scheduler.stop();
    await RedisManager.disconnect();
    _taskService = null;
    _scheduler   = null;
    console.log("[RedisManagement] Stopped.");
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SAFE GETTERS
//  Use these in controllers — never import _taskService/_scheduler directly.
//  Throws a clear error if initRedisManagement() was not called yet.
// ═══════════════════════════════════════════════════════════════════════════════

export function getTaskService() {
    if (!_taskService)
        throw new Error(
            "[RedisManagement] Not initialized. Call initRedisManagement() first."
        );
    return _taskService;
}

export function getScheduler() {
    if (!_scheduler)
        throw new Error(
            "[RedisManagement] Not initialized. Call initRedisManagement() first."
        );
    return _scheduler;
}