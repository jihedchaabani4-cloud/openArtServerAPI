/**
 * test_edit_treatment.mjs
 * Tests EditVideoTreatment logic with mocked dependencies.
 * Runs: node test_edit_treatment.mjs
 */

import { EditVideoTreatment } from './src/video/treatments/EditVideoTreatment.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPromptService = {
    checkPrompt: async (prompt) => {
        console.log(`      [Mock] checkPrompt("${prompt}") → safe`);
        return { safe: true, reason: null };
    },
    generateCameraPrompt: async (cameraText) => {
        console.log(`      [Mock] generateCameraPrompt("${cameraText}")`);
        return {
            cameraPrompt:   "slow dolly zoom in, cinematic pull focus",
            cameraControl:  { type: "zoom_in", speed: "slow" }
        };
    },
};

const mockStorageService = {
    uploadFromUrl: async (fileName, url) => {
        console.log(`      [Mock] uploadFromUrl → ${fileName}`);
        return `https://cdn.example.com/${fileName}`;
    },
};

let mediaIdCounter = 1;
const mockDb = {
    configs: {
        createConfig: async (data) => {
            const id = `config-${Date.now()}`;
            console.log(`      [Mock DB] createConfig → ${id}`);
            return { id };
        },
        createReference: async (data) => {
            console.log(`      [Mock DB] createReference → pos:${data.position} media:${data.ref_media_id}`);
            return {};
        },
    },
    workflows: {
        getWorkflow: async (id) => {
            console.log(`      [Mock DB] getWorkflow → ${id}`);
            return { id, name: 'Test Workflow' };
        },
    },
    media: {
        updateFields: async (id, fields) => {
            console.log(`      [Mock DB] updateFields → media:${id} url:${fields.url}`);
            return {};
        },
    },
    statuses: {
        upsert: async () => {},
    },
};

// Minimal ReferenceProcessor mock (patch via module replacement isn't easy in ESM,
// so we just check that the treatment handles the resolved refs correctly)
const BASE_INPUT = {
    model:        'kling_o3',
    prompt:       'remove the tree in the background',
    ratio:        '16:9',
    duration:     '5s',
    project_id:   'proj-test-001',
    session_id:   'sess-test-001',
    workflow_id:  'wf-test-001',
    media_id:     'media-test-001',
    userId:       'user-test-001',
    references:   [],
    edit_type:    'edit',
};

// ─── Test Runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function run(label, fn) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`🧪 TEST: ${label}`);
    console.log('─'.repeat(60));
    try {
        await fn();
        console.log(`✅ PASSED: ${label}`);
        passed++;
    } catch (err) {
        console.error(`❌ FAILED: ${label}`);
        console.error(`   Error: ${err.message}`);
        failed++;
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'Assertion failed');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// We patch refProcessor inside the treatment manually after instantiation
function makeTimestamp(){
    return { ...BASE_INPUT };
}

function buildTreatment() {
    const t = new EditVideoTreatment({
        promptService:  mockPromptService,
        storageService: mockStorageService,
        db:             mockDb,
    });

    // Patch refProcessor so we don't need real DB/storage for uploads
    t.refProcessor = {
        process: async (refs, userId, project_id, session_id, bucket) => {
            console.log(`      [Mock] refProcessor.process → ${refs.length} refs`);
            return refs.map((r, i) => ({
                ...r,
                url: r.url || `https://cdn.example.com/test-video-${i}.mp4`,
                media_id: r.media_id || `uploaded-${i}`,
            }));
        },
    };

    // Patch executeV2V equivalent: inject generate into provider
    return t;
}

// ── Test 1: Missing project_id throws ────────────────────────────────────────
await run('Throws when project_id missing', async () => {
    const t = buildTreatment();
    try {
        await t.execute({ ...makeTimestamp(), project_id: undefined });
        throw new Error('Should have thrown');
    } catch (err) {
        assert(err.message.includes('project_id'), `Expected project_id error, got: ${err.message}`);
    }
});

// ── Test 2: Fallback when model doesn't support v2v ──────────────────────────
await run('Falls back to EDIT_SUPPORT_MODELS[0] when model=kling_v3', async () => {
    const t = buildTreatment();

    let capturedModel;
    const origRun = t._runBackground.bind(t);
    t._runBackground = async (args) => {
        capturedModel = args.form.model;
        console.log(`      [Intercept] _runBackground called with model: ${capturedModel}`);
        // Don't actually run background
    };

    const result = await t.execute({ ...makeTimestamp(), model: 'kling_v3', edit_type: 'edit' });

    assert(result.status === 'processing', 'status should be processing');
    assert(capturedModel !== 'kling_v3', `Should have fallen back from kling_v3, got: ${capturedModel}`);
    console.log(`      Fell back to: "${capturedModel}" ✅`);
});

// ── Test 3: kling_o3 resolves directly (no fallback) ─────────────────────────
await run('kling_o3 resolves provider directly (no fallback)', async () => {
    const t = buildTreatment();

    let capturedModel;
    t._runBackground = async (args) => {
        capturedModel = args.form.model;
    };

    const result = await t.execute({ ...makeTimestamp(), model: 'kling_o3', edit_type: 'edit' });
    assert(result.status === 'processing', 'status should be processing');
    assert(capturedModel === 'kling_o3', `Expected kling_o3, got: ${capturedModel}`);
    console.log(`      Model stayed as: "${capturedModel}" ✅`);
});

// ── Test 4: Camera edit calls generateCameraPrompt & merges prompt ────────────
await run('Camera edit_type generates camera prompt and merges', async () => {
    const t = buildTreatment();

    let capturedForm;
    t._runBackground = async (args) => {
        capturedForm = args.form;
    };

    await t.execute({
        ...makeTimestamp(),
        model:       'kling_o3',
        prompt:      'A busy street',
        camera_text: 'slow zoom in on the subject',
        edit_type:   'camera',
    });

    assert(capturedForm, 'form should be captured');
    assert(capturedForm.prompt.includes('A busy street'), 'Prompt should include original');
    assert(capturedForm.prompt.includes('slow dolly zoom in'), 'Prompt should include camera_prompt from mock');
    assert(capturedForm.cameraControl?.type === 'zoom_in', 'cameraControl.type should be zoom_in');
    console.log(`      Final prompt:   "${capturedForm.prompt}"`);
    console.log(`      Camera control: ${JSON.stringify(capturedForm.cameraControl)}`);
});

// ── Test 5: edit_type=edit skips camera task (regular prompt used directly) ───
await run('Regular edit uses prompt directly (no camera augmentation)', async () => {
    const t = buildTreatment();

    let originalGenerateCalled = false;
    const origGenerate = mockPromptService.generateCameraPrompt;
    mockPromptService.generateCameraPrompt = async () => {
        originalGenerateCalled = true;
        return origGenerate();
    };

    let capturedForm;
    t._runBackground = async (args) => {
        capturedForm = args.form;
    };

    await t.execute({
        ...makeTimestamp(),
        model:     'kling_o3',
        prompt:    'Make the sky purple',
        edit_type: 'edit',
    });

    mockPromptService.generateCameraPrompt = origGenerate;

    assert(!originalGenerateCalled, 'generateCameraPrompt should NOT have been called for regular edit');
    assert(capturedForm.prompt === 'Make the sky purple', `Prompt should be unchanged, got: "${capturedForm.prompt}"`);
    console.log(`      Prompt unchanged: "${capturedForm.prompt}" ✅`);
});

// ── Test 6: media_id auto-injected into references ───────────────────────────
await run('media_id is auto-injected as video reference when not present', async () => {
    const t = buildTreatment();

    let capturedForm;
    t._runBackground = async (args) => {
        capturedForm = args.form;
    };

    await t.execute({
        ...makeTimestamp(),
        model:      'kling_o3',
        media_id:   'my-target-video',
        references: [],
        edit_type:  'edit',
    });

    // The base video URL should come from the injected media_id ref
    assert(capturedForm.video !== undefined, 'form.video should be set from injected media_id ref');
    console.log(`      form.video: ${capturedForm.video} ✅`);
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(60) + '\n');

if (failed > 0) process.exit(1);
