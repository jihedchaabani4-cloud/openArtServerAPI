import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertWorkerConfigured,
  createGenerationFailureHandler,
  handleUseCaseWorkerFailure,
  processUseCaseJob,
  useCaseWorker,
  USECASE_WORKER_OPTIONS,
} from "../../../src/systems/generation/internal/workers/useCaseWorker.js";
import { WorkflowExecutor } from "../../../src/systems/workflow-engine/internal/core/WorkflowExecutor.js";
import { NodeRegistry } from "../../../src/systems/workflow-engine/internal/core/NodeRegistry.js";
import { ImageGenerateNode, VideoGenerateNode, LlmNode } from "../../../src/systems/workflow-engine/internal/nodes/index.js";
import {
  WorkflowDispatchService,
  getUseCaseQueue,
} from "../../../src/systems/generation/internal/services/WorkflowDispatchService.js";
import "../../../src/container.js";
import { configureMedia, getMediaRepository } from "#media/tools";
import { baseLogger, LogEvents } from "#shared";
import { redisConnection } from "#shared/redis";
import { walletMaintenanceQueue } from "../../../src/systems/billing/internal/workers/walletQueue.js";

// ─── Source: useCaseWorkerFailureIdempotencyBoundary.test.js ───
{
describe("RC1.4-D3(3) — UseCaseWorker Failure Handler Idempotency, Crash Cleanup & M5 Context Forwarding", () => {
  let originalMediaRepo;

  beforeEach(() => {
    originalMediaRepo = getMediaRepository();
  });

  afterEach(() => {
    configureMedia({ mediaRepo: originalMediaRepo });
  });

  it("TEST 1: useCaseWorker failure handler marks ONLY explicit serverContext.mediaIds (never generic input.media_id)", async () => {
    const workflowId = "wf-idem-test-123";

    const updatedMedia = [];
    configureMedia({
      mediaRepo: {
        updateFields: async (mediaId, patch) => {
          updatedMedia.push({ mediaId, ...patch });
          return { id: mediaId, ...patch };
        },
      },
    });

    const failedJob = {
      id: "job-failed-test-999",
      data: {
        serverContext: {
          workflowId,
          mediaIds: ["media-test-1"],
        },
        input: {
          workflow_id: workflowId,
          media_id: "media-unrelated-input-only",
        },
      },
    };
    const testError = new Error("Simulated worker process crash");

    await handleUseCaseWorkerFailure(failedJob, testError);

    assert.equal(updatedMedia.length, 1);
    assert.equal(updatedMedia[0].mediaId, "media-test-1");
    assert.equal(updatedMedia[0].status, "failed");

    // Read-only workflow with only input.media_id and NO serverContext.mediaIds must NEVER mutate DB
    updatedMedia.length = 0;
    const handler = createGenerationFailureHandler({
      markMediaFailed: async ({ mediaId }) => {
        updatedMedia.push({ mediaId });
      },
    });
    await handler({
      input: { media_id: "completed-media-do-not-touch" },
      serverContext: null,
      error: new Error("Read-only analysis failed"),
    });
    assert.equal(updatedMedia.length, 0, "Failure handler must never mutate generic input.media_id");
  });

  it("TEST 2 (M5): WorkflowDispatchService.dispatch preserves serverContext, executionId, and workflowRunId in queued payload", async () => {
    const addedJobs = [];
    const fakeBullQueue = {
      add: async (name, data, opts) => {
        const job = { id: opts.jobId, name, data, opts };
        addedJobs.push(job);
        return job;
      },
    };

    const dispatcher = new WorkflowDispatchService({ queue: fakeBullQueue });
    const serverContext = {
      workflowId: "wf-m5-100",
      mediaIds: ["media-m5-100"],
      projectId: "proj-m5-100",
    };

    const res = await dispatcher.dispatch({
      useCaseId: "image-generation-v3",
      input: { prompt: "A serene fjord", model: "nanobana_2", media_id: "media-m5-100" },
      userId: "user-m5-1",
      executionId: "exec-m5-abc",
      workflowRunId: "exec-m5-abc",
      idempotencyKey: "exec:image-generation-v3:user-m5-1:exec-m5-abc",
      traceId: "trace-m5-1",
      serverContext,
    });

    assert.equal(addedJobs.length, 1);
    assert.equal(res.status, "queued");
    assert.equal(res.jobId, "usecase-exec-m5-abc");
    assert.deepEqual(addedJobs[0].data.serverContext, serverContext, "serverContext must be preserved intact in BullMQ payload");
    assert.equal(addedJobs[0].data.executionId, "exec-m5-abc");
    assert.equal(addedJobs[0].data.workflowRunId, "exec-m5-abc");
  });

  it("TEST 3 (M5): useCaseWorker processUseCaseJob spawns a fresh engine per job and forwards runId, jobId, adapters, and serverContext", async () => {
    const capturedCalls = [];
    const createdEngines = [];
    const fakeFactory = (factoryOpts) => {
      const fakeEngine = {
        factoryOpts,
        runWorkflow: async (workflowOrId, input, opts) => {
          capturedCalls.push({ workflowOrId, input, opts, factoryOpts });
          return { status: "completed", runId: opts.runId, executionId: opts.executionId };
        },
      };
      createdEngines.push(fakeEngine);
      return fakeEngine;
    };

    const fakeJob1 = {
      id: "usecase-exec-m5-xyz",
      data: {
        useCaseId: "image-generation-v3",
        userId: "user-m5-2",
        executionId: "exec-m5-xyz",
        input: { prompt: "A glass lighthouse", model: "nanobana_2", media_id: "media-m5-200" },
        serverContext: {
          workflowId: "wf-m5-200",
          mediaIds: ["media-m5-200"],
          projectId: "proj-m5-200",
        },
      },
    };
    const fakeJob2 = {
      id: "usecase-exec-m5-2",
      data: {
        useCaseId: "image-generation-v3",
        userId: "user-m5-3",
        executionId: "exec-m5-2",
        input: { prompt: "A crystal desert", model: "nanobana_2", media_id: "media-m5-201" },
        serverContext: { workflowId: "wf-m5-201", mediaIds: ["media-m5-201"] },
      },
    };

    const [res1, res2] = await Promise.all([
      processUseCaseJob(fakeJob1, { engineFactory: fakeFactory }),
      processUseCaseJob(fakeJob2, { engineFactory: fakeFactory }),
    ]);

    assert.equal(res1.status, "completed");
    assert.equal(res2.status, "completed");
    assert.equal(createdEngines.length, 2, "Must instantiate a fresh isolated engine per job");
    assert.notStrictEqual(createdEngines[0], createdEngines[1]);

    const capturedCall = capturedCalls[0];
    assert.equal(capturedCall.workflowOrId, "image-generation-v3");
    assert.deepEqual(capturedCall.input, fakeJob1.data.input);
    assert.equal(typeof capturedCall.factoryOpts.onFailure, "function");
    assert.equal(typeof capturedCall.factoryOpts.adapters?.completeMedia, "function");
    assert.equal(capturedCall.opts.executionId, "exec-m5-xyz");
    assert.equal(capturedCall.opts.runId, "exec-m5-xyz");
    assert.equal(capturedCall.opts.jobId, "usecase-exec-m5-xyz");
    assert.deepEqual(capturedCall.opts.serverContext, fakeJob1.data.serverContext);
  });

  it("TEST 4 (Bootstrap): standalone root worker.js wires WorkflowAdapters, markMediaFailed, Billing, Media, and Identity without index.js", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const script = `
      const { worker } = await import("./worker.js");
      const { getMarkMediaFailed, getWorkflowAdapters } = await import("./src/systems/generation/internal/services/serviceAccessor.js");
      const { assertWorkerConfigured } = await import("./src/systems/generation/internal/workers/useCaseWorker.js");
      const { getDefaultWalletService } = await import("./src/systems/billing/internal/services/serviceAccessor.js");
      const { getMediaRepository } = await import("#media/tools");
      const cfg = assertWorkerConfigured();
      if (!worker) throw new Error("root worker.js did not export worker");
      if (typeof cfg.markMediaFailed !== "function") throw new Error("markMediaFailed not wired");
      if (getMarkMediaFailed() !== cfg.markMediaFailed) throw new Error("serviceAccessor markMediaFailed mismatch");
      if (getWorkflowAdapters() !== cfg.workflowAdapters) throw new Error("serviceAccessor workflowAdapters mismatch");
      if (!getDefaultWalletService()) throw new Error("WalletService not wired in billing serviceAccessor");
      if (!getMediaRepository()) throw new Error("MediaRepository not wired");
      console.log("STANDALONE_WORKER_OK");
      process.exit(0);
    `;
    const out = execFileSync(
      process.execPath,
      ["--import", "./tests/setup-env.js", "--input-type=module", "-e", script],
      { cwd: repoRoot, encoding: "utf8", timeout: 15000 }
    );
    assert.match(out, /STANDALONE_WORKER_OK/);
    assert.ok(assertWorkerConfigured(), "current process container-wired worker is also configured");
  });

  it("TEST 5 (Fail-fast guard): useCaseWorker fails fast with clear root worker.js guidance when container.js was not loaded", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const script = `
      const { assertWorkerConfigured } = await import("./src/systems/generation/internal/workers/useCaseWorker.js");
      try {
        assertWorkerConfigured();
        console.log("UNEXPECTED_SUCCESS");
        process.exit(1);
      } catch (err) {
        console.log(err.message);
        process.exit(0);
      }
    `;
    const out = execFileSync(
      process.execPath,
      ["--import", "./tests/setup-env.js", "--input-type=module", "-e", script],
      { cwd: repoRoot, encoding: "utf8", timeout: 15000 }
    );
    assert.match(out, /markMediaFailed is not configured/);
    assert.match(out, /worker\.js/);
  });

  it("TEST 6 (P2-3): WorkflowDispatchService.dispatch logs job.queued AFTER queue.add resolves with enqueueDurationMs and never logs on failure", async () => {
    const timeline = [];
    const origInfo = baseLogger.info;
    baseLogger.info = (payload, msg) => {
      if (payload?.event === LogEvents.JOB_QUEUED) {
        timeline.push({ step: "log.job.queued", payload });
      }
      return origInfo.call(baseLogger, payload, msg);
    };

    try {
      const fakeSuccessQueue = {
        add: async (name, data, opts) => {
          timeline.push({ step: "queue.add.start" });
          await new Promise((resolve) => setTimeout(resolve, 5));
          timeline.push({ step: "queue.add.resolved" });
          return { id: opts.jobId, name, data, opts };
        },
      };

      const dispatcher = new WorkflowDispatchService({ queue: fakeSuccessQueue });
      await dispatcher.dispatch({
        useCaseId: "video-generation-v3",
        input: { prompt: "Sunrise over dunes" },
        userId: "user-p23-queue",
        executionId: "exec-p23-ok",
      });

      assert.deepEqual(
        timeline.map((e) => e.step),
        ["queue.add.start", "queue.add.resolved", "log.job.queued"],
        "job.queued MUST be logged strictly AFTER queue.add resolves"
      );
      const loggedPayload = timeline[2].payload;
      assert.equal(loggedPayload.event, LogEvents.JOB_QUEUED);
      assert.equal(loggedPayload.jobId, "usecase-exec-p23-ok");
      assert.equal(typeof loggedPayload.enqueueDurationMs, "number");
      assert.ok(loggedPayload.enqueueDurationMs >= 0);

      timeline.length = 0;
      const fakeFailingQueue = {
        add: async () => {
          throw new Error("Redis ECONNREFUSED");
        },
      };
      const failingDispatcher = new WorkflowDispatchService({ queue: fakeFailingQueue });
      await assert.rejects(
        () =>
          failingDispatcher.dispatch({
            useCaseId: "video-generation-v3",
            input: { prompt: "Will fail to enqueue" },
            userId: "user-p23-queue",
            executionId: "exec-p23-fail",
          }),
        /Failed to enqueue workflow/
      );

      assert.equal(
        timeline.filter((e) => e.step === "log.job.queued").length,
        0,
        "job.queued MUST NOT be logged when queue.add throws"
      );
    } finally {
      baseLogger.info = origInfo;
    }
  });

  it("TEST 7 (P2-3): handleUseCaseWorkerFailure logs at DEBUG (0 ERROR) when err.errorReport is present, and logs ERROR for uncaught crashes", async () => {
    const errorLogs = [];
    const debugLogs = [];
    const origError = baseLogger.error;
    const origDebug = baseLogger.debug;

    baseLogger.error = (payload, msg) => {
      errorLogs.push({ payload, msg });
      return origError.call(baseLogger, payload, msg);
    };
    baseLogger.debug = (payload, msg) => {
      debugLogs.push({ payload, msg });
      return origDebug.call(baseLogger, payload, msg);
    };

    try {
      const handledErr = new Error("Safety check unavailable");
      handledErr.errorReport = { code: "SAFETY_CHECK_UNAVAILABLE", category: "UPSTREAM_FAULT" };

      await handleUseCaseWorkerFailure({ id: "job-handled-1", data: {} }, handledErr);

      assert.equal(
        errorLogs.filter((l) => l.payload?.event === LogEvents.JOB_FAILED).length,
        0
      );
      assert.equal(
        debugLogs.filter((l) => l.payload?.event === LogEvents.JOB_FAILED && l.payload?.jobId === "job-handled-1").length,
        1
      );

      errorLogs.length = 0;
      const crashErr = new Error("Uncaught worker OOM crash");
      await handleUseCaseWorkerFailure({ id: "job-crash-2", data: {} }, crashErr);

      assert.equal(
        errorLogs.filter((l) => l.payload?.event === LogEvents.JOB_FAILED && l.payload?.jobId === "job-crash-2").length,
        1
      );
    } finally {
      baseLogger.error = origError;
      baseLogger.debug = origDebug;
    }
  });
});
}

// ─── Source: queueErrorHandlers.test.js ───
{
if (redisConnection?.options) {
    redisConnection.options.retryStrategy = () => null;
}

describe("Queue and Worker Error Event Handlers", () => {
    after(() => {
        if (typeof redisConnection?.disconnect === "function") {
            redisConnection.disconnect(false);
        }
    });

    it("useCaseQueue handles error events without throwing or crashing", async () => {
        const queue = await getUseCaseQueue();
        assert.doesNotThrow(() => {
            queue.emit("error", new Error("Simulated Redis disconnect on useCaseQueue"));
        });
    });

    it("useCaseWorker handles error events without throwing or crashing", () => {
        assert.doesNotThrow(() => {
            useCaseWorker.emit("error", new Error("Simulated Redis disconnect on useCaseWorker"));
        });
    });

    it("useCaseWorker enforces default concurrency 6, long lock duration, and fail-closed maxStalledCount=0", () => {
        assert.equal(USECASE_WORKER_OPTIONS.concurrency, 6);
        assert.equal(USECASE_WORKER_OPTIONS.lockDuration, 300_000);
        assert.equal(USECASE_WORKER_OPTIONS.lockRenewTime, 60_000);
        assert.equal(USECASE_WORKER_OPTIONS.stalledInterval, 60_000);
        assert.equal(USECASE_WORKER_OPTIONS.maxStalledCount, 0);
        assert.doesNotThrow(() => {
            useCaseWorker.emit("stalled", "job-stalled-1");
        });
    });

    it("V3 AI generation nodes enforce single-attempt fail-fast execution (zero automatic retries)", async () => {
        const registry = new NodeRegistry();
        registry.register(ImageGenerateNode);
        registry.register(VideoGenerateNode);
        registry.register(LlmNode);
        registry.register({
            type: "custom.sink",
            category: "output",
            OUTPUT_NODE: true,
            CACHEABLE: false,
            INPUT_TYPES: { required: { value: { type: "ANY" } }, optional: {} },
            RETURN_TYPES: { status: "STRING" },
            estimateCost: () => 0,
            execute: async () => ({ status: "saved" }),
        });
        const executor = new WorkflowExecutor(registry);

        let imageAttempts = 0;
        await assert.rejects(
            () =>
                executor.execute({
                    workflow: {
                        id: "fail-fast-image",
                        nodes: [
                            { id: "gen", type: "base.image_generate", inputs: { model: "nanobana-2", prompt: "test" } },
                            { id: "sink", type: "custom.sink", inputs: { value: { fromNode: "gen", output: "image_url" } } },
                        ],
                    },
                    context: {
                        executeProvider: async () => {
                            imageAttempts += 1;
                            const err = new Error("WaveSpeed 503");
                            err.statusCode = 503;
                            err.retryable = true;
                            throw err;
                        },
                    },
                }),
            /WaveSpeed 503/
        );
        assert.equal(imageAttempts, 1);

        let videoAttempts = 0;
        await assert.rejects(
            () =>
                executor.execute({
                    workflow: {
                        id: "fail-fast-video",
                        nodes: [
                            { id: "vid", type: "base.video_generate", inputs: { model: "wan_3_0", prompt: "test video" } },
                            { id: "sink", type: "custom.sink", inputs: { value: { fromNode: "vid", output: "video_url" } } },
                        ],
                    },
                    context: {
                        executeProvider: async () => {
                            videoAttempts += 1;
                            const err = new Error("WaveSpeed 504 timeout");
                            err.statusCode = 504;
                            err.retryable = true;
                            throw err;
                        },
                    },
                }),
            /WaveSpeed 504 timeout/
        );
        assert.equal(videoAttempts, 1);

        let llmAttempts = 0;
        await assert.rejects(
            () =>
                executor.execute({
                    workflow: {
                        id: "fail-fast-llm",
                        nodes: [
                            { id: "llm", type: "base.llm", inputs: { prompt: "check safety" } },
                            { id: "sink", type: "custom.sink", inputs: { value: { fromNode: "llm", output: "text" } } },
                        ],
                    },
                    context: {
                        executeLLM: async () => {
                            llmAttempts += 1;
                            const err = new Error("Gemini 429");
                            err.statusCode = 429;
                            err.retryable = true;
                            throw err;
                        },
                    },
                }),
            /Gemini 429/
        );
        assert.equal(llmAttempts, 1);
    });

    it("walletMaintenanceQueue handles error events without throwing or crashing", () => {
        assert.doesNotThrow(() => {
            walletMaintenanceQueue.emit("error", new Error("Simulated Redis disconnect on walletMaintenanceQueue"));
        });
    });
});
}
