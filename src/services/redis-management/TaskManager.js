import { randomUUID }  from "crypto";
import { EventEmitter } from "events";
import { Redis }        from "@upstash/redis";

const NORMAL_USER_DELAY_MS = 10000;

// ═══════════════════════════════════════════════════════════════════════════════
//  REDIS MANAGER
//  Singleton — one connection shared across the whole app.
//  Call RedisManager.getInstance() anywhere — never creates duplicates.
// ═══════════════════════════════════════════════════════════════════════════════

export class RedisManager {
    static _instance = null;

    /**
     * @param {object} [opts]
     * @param {string} [opts.url]        falls back to UPSTASH_REDIS_REST_URL
     * @param {string} [opts.token]      falls back to UPSTASH_REDIS_REST_TOKEN
     * @param {number} [opts.maxRetries]
     */
    static getInstance({ url, token, maxRetries = 10 } = {}) {
        if (RedisManager._instance) return RedisManager._instance;

        const redisUrl   = url   || process.env.UPSTASH_REDIS_REST_URL;
        const redisToken = token || process.env.UPSTASH_REDIS_REST_TOKEN;

        if (!redisUrl || !redisToken)
            throw new Error(
                "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required"
            );

        const client = new Redis({
            url:   redisUrl,
            token: redisToken,
            retry: {
                retries: maxRetries,
                backoff: (n) => Math.min(Math.exp(n) * 50, 1000),
            },
        });

        console.log("[Redis] Upstash REST client ready");
        RedisManager._instance = client;
        return client;
    }

    static async disconnect() {
        if (RedisManager._instance) {
            RedisManager._instance = null;
            console.log("[Redis] disconnected");
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TASK SERVICE
//  Storage + queue management only — zero execution logic.
//
//  Redis keys:
//    task:{id}               → Hash  (all task fields, serialized as strings)
//    tasks:queue:pro         → ZSET  (score = created_at ms → FIFO order)
//    tasks:queue:normal      → ZSET  (score = created_at ms → FIFO order)
//    tasks:status:{status}   → ZSET  (score = created_at ms → for listing)
//
//  Lifecycle:
//    createTask()    → stores Hash + pushes id to queue ZSET + status ZSET
//    popFromQueue()  → atomic ZPOPMIN, called only by Scheduler
//    updateTask()    → updates Hash fields + moves between status ZSETs
//    listTasks()     → reads status ZSETs + fetches Hashes, applies filters
// ═══════════════════════════════════════════════════════════════════════════════

export class TaskService {
    /**
     * @param {object}   opts
     * @param {Redis}    opts.redis
     * @param {number}   [opts.ttl=86400]       task TTL in seconds (default 24h)
     * @param {Function} [opts.onTaskCreated]   hook — Scheduler wires this to _signal()
     */
    constructor({ redis, ttl = 86400, onTaskCreated = null }) {
        this.redis         = redis;
        this.ttl           = ttl;
        this.onTaskCreated = onTaskCreated;
    }

    // ── Keys ──────────────────────────────────────────────────────────────────

    _taskKey(id)       { return `task:${id}`; }
    _statusKey(status) { return `tasks:status:${status}`; }
    _queueKey(type)    { return `tasks:queue:${type}`; }   // "pro" | "normal"

    // ── Create ────────────────────────────────────────────────────────────────

    /**
     * Create a task, store it, push to the correct queue, then signal Scheduler.
     *
     * @param {object}         input
     * @param {"pro"|"normal"} input.userType
     * @param {string}         input.userId
     * @param {string}         input.runner       "motion" | "image" | ...
     * @param {object}         input.data         plain JSON-serializable prepared object
     * @param {string}         [input.workflow_id]
     * @returns {Promise<object>}  the created task
     */
    async createTask({ userType, userId, runner, data, workflow_id, ...rest }) {
        if (!userType) throw new Error("userType required: 'pro' | 'normal'");
        if (!userId)   throw new Error("userId required");
        if (!runner)   throw new Error("runner required");
        if (!data)     throw new Error("data required — pass the prepared object");

        const id     = randomUUID();
        const now    = Date.now();
        const status = "pending";

        const task = {
            id,
            status,
            created_at:  now,
            updated_at:  now,
            userType,
            userId,
            runner,
            workflow_id: workflow_id ?? data?.workflow?.id ?? null,
            data,
            ...rest,
        };

        // 1. Store as Hash (all values serialized to strings)
        await this.redis.hset(this._taskKey(id), this._serialize(task));
        await this.redis.expire(this._taskKey(id), this.ttl);

        // 2. Push to correct queue (score = created_at + optional delay → FIFO with delay)
        const delay = userType === "normal" ? NORMAL_USER_DELAY_MS : 0;
        const score = now + delay;
        await this.redis.zadd(this._queueKey(userType), { score: score, member: id });

        // 3. Track in status ZSET (for listing/filtering)
        await this.redis.zadd(this._statusKey(status), { score: now, member: id });

        console.log(
            `[TaskService] created | id:${id} | type:${userType} | runner:${runner}${delay > 0 ? ` | delayed:${delay}ms` : ""}`
        );

        // 4. Wake up Scheduler immediately — no need to wait for next poll
        this.onTaskCreated?.();

        return task;
    }

    // ── Get ───────────────────────────────────────────────────────────────────

    /**
     * Fetch a single task by ID.
     * Returns null if not found or TTL expired.
     *
     * @param {string} id
     * @returns {Promise<object|null>}
     */
    async getTask(id) {
        const raw = await this.redis.hgetall(this._taskKey(id));
        if (!raw || Object.keys(raw).length === 0) return null;
        return this._deserialize(raw);
    }

    // ── Update ────────────────────────────────────────────────────────────────

    /**
     * Update task fields.
     * If status changes → automatically moves id between status ZSETs.
     *
     * @param {string} id
     * @param {object} fields   partial fields to update (including optional status)
     * @returns {Promise<object>}  updated task
     */
    async updateTask(id, fields) {
        const existing = await this.getTask(id);
        if (!existing) throw new Error(`Task not found: ${id}`);

        const oldStatus = existing.status;
        const newStatus = fields.status || oldStatus;

        const updated = {
            ...existing,
            ...fields,
            status:     newStatus,
            updated_at: Date.now(),
        };

        await this.redis.hset(this._taskKey(id), this._serialize(updated));
        await this.redis.expire(this._taskKey(id), this.ttl);

        // Move between status ZSETs if status changed
        if (newStatus !== oldStatus) {
            await this.redis.zrem(this._statusKey(oldStatus), id);
            await this.redis.zadd(this._statusKey(newStatus), {
                score:  existing.created_at,
                member: id,
            });
            console.log(
                `[TaskService] status | id:${id} | ${oldStatus} -> ${newStatus}`
            );
        }

        return updated;
    }

    // ── Delete ────────────────────────────────────────────────────────────────

    /**
     * Fully remove a task from Redis.
     * Cleans: Hash + status ZSET + both queue ZSETs.
     *
     * @param {string} id
     * @returns {Promise<boolean>}
     */
    async deleteTask(id) {
        const existing = await this.getTask(id);
        if (!existing) return false;

        await this.redis.del(this._taskKey(id));
        await this.redis.zrem(this._statusKey(existing.status), id);
        await this.redis.zrem(this._queueKey("pro"),    id);
        await this.redis.zrem(this._queueKey("normal"), id);

        console.log(`[TaskService] deleted | id:${id}`);
        return true;
    }

    // ── List ──────────────────────────────────────────────────────────────────

    /**
     * List tasks with optional filters.
     *
     * @param {object}        [opts]
     * @param {string}        [opts.status]    "pending"|"processing"|"success"|"failed"
     * @param {string}        [opts.userType]  "pro"|"normal"
     * @param {string}        [opts.userId]
     * @param {string}        [opts.runner]    "motion"|"image"|...
     * @param {number}        [opts.limit]     max results
     * @param {"asc"|"desc"}  [opts.order]     default "desc" (newest first)
     * @returns {Promise<object[]>}
     */
    async listTasks({ status, userType, userId, runner, limit, order = "desc" } = {}) {
        let ids = [];

        if (status) {
            ids = await this.redis.zrange(this._statusKey(status), 0, -1);
        } else {
            const allIdsArr = await Promise.all(
                ["pending", "processing", "success", "failed"]
                    .map(s => this.redis.zrange(this._statusKey(s), 0, -1))
            );
            ids = allIdsArr.flat();
        }

        if (ids.length === 0) return [];

        // Fetch all in parallel
        let tasks = await Promise.all(ids.map(id => this.getTask(id)));

        // Drop expired (TTL hit → Hash gone → getTask returned null)
        tasks = tasks.filter(Boolean);

        if (userType) tasks = tasks.filter(t => t.userType === userType);
        if (userId)   tasks = tasks.filter(t => t.userId   === userId);
        if (runner)   tasks = tasks.filter(t => t.runner   === runner);

        tasks.sort((a, b) =>
            order === "asc"
                ? a.created_at - b.created_at
                : b.created_at - a.created_at
        );

        return limit ? tasks.slice(0, limit) : tasks;
    }

    // ── Queue helpers (Scheduler only) ────────────────────────────────────────

    /** How many tasks are pending in a queue. */
    async queueCount(type) {
        return this.redis.zcard(this._queueKey(type));
    }

    /** Peek at oldest N tasks without removing them. */
    async peekQueue(type, count = 1) {
        const ids   = await this.redis.zrange(this._queueKey(type), 0, count - 1);
        const tasks = await Promise.all(ids.map(id => this.getTask(id)));
        return tasks.filter(Boolean);
    }

    /**
     * Atomically pop the oldest task from a queue (ZPOPMIN).
     * Called ONLY by Scheduler — never from controllers.
     *
     * @param {"pro"|"normal"} type
     * @returns {Promise<object|null>}
     */
    async popFromQueue(type) {
        const key = this._queueKey(type);
        const now = Date.now();

        // 1. Peek at oldest to check score (score = creation_time + delay)
        const oldest = await this.redis.zrange(key, 0, 0, { withScores: true });
        if (!oldest || oldest.length === 0) return null;

        // Upstash return format check
        const id    = oldest[0]?.member ?? oldest[0];
        const score = oldest[0]?.score  ?? oldest[1];

        if (!id) return null;

        // 2. Not ready?
        if (score > now) {
            return { id, notReady: true, readyAt: score };
        }

        // 3. Ready -> Remove atomically (mostly)
        // Note: in high-concurrency multi-worker, use Lua script for atomicity
        await this.redis.zrem(key, id);

        const task = await this.getTask(id);
        if (!task) {
            console.warn(`[TaskService] popFromQueue | id:${id} expired, skipping`);
            return null;
        }

        return task;
    }

    // ── Serialize / Deserialize ───────────────────────────────────────────────
    // Redis hset requires all values to be strings.

    _serialize(obj) {
        const flat = {};
        for (const [k, v] of Object.entries(obj)) {
            flat[k] = typeof v === "object" && v !== null
                ? JSON.stringify(v)
                : String(v ?? "");
        }
        return flat;
    }

    _deserialize(raw) {
        const obj = {};
        for (const [k, v] of Object.entries(raw)) {
            try   { obj[k] = JSON.parse(v); }
            catch { obj[k] = v; }
        }
        return obj;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SCHEDULER
//  Brain of the task system — event-driven, zero busy polling.
//
//  Behaviour:
//    • Sleeps indefinitely when both queues are empty (no Redis calls at idle)
//    • Wakes up instantly when createTask() fires onTaskCreated signal
//    • Wakes up instantly when a running task finishes (slot freed)
//    • Weighted fairness: proWeight pro picks then normalWeight normal picks per cycle
//    • Hard cap: never exceeds maxConcurrency parallel runs
// ═══════════════════════════════════════════════════════════════════════════════

export class Scheduler extends EventEmitter {
    /**
     * @param {object}      opts
     * @param {TaskService} opts.taskService
     * @param {{ run: Function }} opts.runner    object with async run(task) method
     * @param {number} [opts.maxConcurrency=30]
     * @param {number} [opts.proWeight=3]        pro picks per cycle
     * @param {number} [opts.normalWeight=1]     normal picks per cycle
     * @param {number} [opts.fullPoolSleep=50]   ms to sleep when pool is full
     */
    constructor({
        taskService,
        runner,
        maxConcurrency = 30,
        proWeight      = 3,
        normalWeight   = 1,
        fullPoolSleep  = 50,
    }) {
        super();
        this.taskService    = taskService;
        this.runner         = runner;
        this.maxConcurrency = maxConcurrency;
        this.proWeight      = proWeight;
        this.normalWeight   = normalWeight;
        this.fullPoolSleep  = fullPoolSleep;

        this._running = 0;
        this._counter = 0;
        this._active  = false;
        this._wakeUp  = null;  // resolve fn of the current _waitForSignal() promise

        // Wire TaskService signal → wake up this loop
        this.taskService.onTaskCreated = () => this._signal();
    }

    // ── Public ────────────────────────────────────────────────────────────────

    start() {
        if (this._active) return;
        this._active = true;
        console.log(
            `[Scheduler] started | max:${this.maxConcurrency} | ` +
            `ratio:${this.proWeight}pro:${this.normalWeight}normal`
        );
        this._loop();
    }

    stop() {
        this._active = false;
        this._signal();  // unblock _waitForSignal so the while loop can exit
        console.log("[Scheduler] stopped");
    }

    /** Current number of actively running tasks. */
    get runningCount() { return this._running; }

    /** Live stats — useful for monitoring / health endpoints. */
    async stats() {
        const [pro, normal] = await Promise.all([
            this.taskService.queueCount("pro"),
            this.taskService.queueCount("normal"),
        ]);
        return {
            running:        this._running,
            maxConcurrency: this.maxConcurrency,
            queue:          { pro, normal, total: pro + normal },
        };
    }

    // ── Main loop ─────────────────────────────────────────────────────────────
    //
    //  State machine (one iteration):
    //
    //    pool full?   → sleep fullPoolSleep ms → retry
    //    task found?  → _dispatch() (non-blocking) → loop again immediately
    //    both empty?  → _waitForSignal() (sleep forever) → retry on wake
    //
    //  Zero Redis calls when idle — only wakes on real events. ✅

    async _loop() {
        while (this._active) {

            // Hard cap reached — short sleep then retry
            if (this._running >= this.maxConcurrency) {
                await this._sleep(this.fullPoolSleep);
                continue;
            }

            const result = await this._pickNext();

            if (!result || (!result.task && !result.nextReadyAt)) {
                // Both queues empty — sleep until signal arrives
                await this._waitForSignal();
                continue;
            }

            if (!result.task && result.nextReadyAt) {
                // Task(s) exists but not ready yet — sleep until first one is ready (or new signal)
                const waitMs = Math.max(10, result.nextReadyAt - Date.now());
                await this._waitForSignal(waitMs);
                continue;
            }

            // Fire and forget — loop continues immediately to fill next slot
            this._dispatch(result.task);
        }
    }

    // ── Weighted fair pick ────────────────────────────────────────────────────
    //
    //  cycle length = proWeight + normalWeight  (default: 4)
    //
    //  pos 0,1,2  (< proWeight=3)  → try pro first, fallback to normal
    //  pos 3      (≥ proWeight=3)  → try normal first, fallback to pro
    //
    //  If the preferred queue is empty → fallback to the other one.
    //  If both empty → return null (loop will sleep).

    async _pickNext() {
        const cycleLen = this.proWeight + this.normalWeight;
        const pos      = this._counter % cycleLen;

        const queues = pos < this.proWeight ? ["pro", "normal"] : ["normal", "pro"];
        let nextReadyAt = null;

        for (const type of queues) {
            const result = await this.taskService.popFromQueue(type);
            if (!result) continue;

            if (result.notReady) {
                if (!nextReadyAt || result.readyAt < nextReadyAt) {
                    nextReadyAt = result.readyAt;
                }
                continue;
            }

            // Real task found
            this._counter++;
            return { task: result };
        }

        return { task: null, nextReadyAt };
    }

    // ── Dispatch ──────────────────────────────────────────────────────────────
    //  Runs a single task:
    //    1. mark processing in Redis
    //    2. call runner.run(task)
    //    3. mark success or failed
    //    4. free the slot → signal loop (another task may be waiting)

    async _dispatch(task) {
        this._running++;
        try {
            await this.taskService.updateTask(task.id, { status: "processing" });

            console.log(
                `[Scheduler] dispatch | id:${task.id} | runner:${task.runner} | ` +
                `type:${task.userType} | running:${this._running}/${this.maxConcurrency}`
            );

            await this.runner.run(task);

            await this.taskService.updateTask(task.id, { status: "success" });
            console.log(`[Scheduler] done | id:${task.id}`);

        } catch (err) {
            console.error(`[Scheduler] failed | id:${task.id} | ${err.message}`);
            try {
                await this.taskService.updateTask(task.id, {
                    status: "failed",
                    error:  err.message,
                });
            } catch (_) { /* ignore secondary errors */ }

        } finally {
            this._running--;
            // Slot freed — wake loop so it can pick the next waiting task
            this._signal();
        }
    }

    // ── Signal / wait helpers ─────────────────────────────────────────────────

    /** Resolve the current _waitForSignal() promise (wake up the loop). */
    _signal() {
        if (this._wakeUp) {
            const resolve = this._wakeUp;
            this._wakeUp  = null;
            resolve();
        }
    }

    /**
     * Park the loop here until _signal() is called OR timeout expires.
     * Uses a single Promise resolve — no timers, no polling.
     */
    _waitForSignal(ms = null) {
        return new Promise(resolve => {
            let timeout = null;
            
            const cleanup = () => {
                if (timeout) clearTimeout(timeout);
                this._wakeUp = null;
                resolve();
            };

            this._wakeUp = cleanup;

            if (ms !== null) {
                timeout = setTimeout(cleanup, ms);
            }
        });
    }

    _sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FACTORY  —  createTaskManager()
//  Wire Redis + TaskService + Scheduler together in one call.
//
//  Usage:
//    const { taskService, scheduler } = createTaskManager({ runner });
//    scheduler.start();
// ═══════════════════════════════════════════════════════════════════════════════

export function createTaskManager({
    runner,
    redisUrl,
    redisToken,
    ttl            = 86400,
    maxConcurrency = 30,
    proWeight      = 3,
    normalWeight   = 1,
}) {
    const redis       = RedisManager.getInstance({ url: redisUrl, token: redisToken });
    const taskService = new TaskService({ redis, ttl });
    const scheduler   = new Scheduler({
        taskService,
        runner,
        maxConcurrency,
        proWeight,
        normalWeight,
    });

    return { redis, taskService, scheduler };
}