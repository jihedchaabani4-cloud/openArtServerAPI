// Global test environment setup for node:test runner
// Ensures hermetic, zero-dependency test execution on clean checkouts without a real .env
process.env.NODE_ENV = "test";

// Mock Supabase endpoint & keys for unit and boundary tests (never network reachable)
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://placeholder-test-project.supabase.co";
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || "placeholder-test-anon-key-not-for-prod";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-test-service-role-key-not-for-prod";

// Internal service-to-service secret for test mode (>= 32 chars)
process.env.INTERNAL_SECRET = process.env.INTERNAL_SECRET || "placeholder-internal-s2s-secret-32-chars-test!!";

// Disable dev auth bypass by default
process.env.DEV_AUTH_BYPASS = process.env.DEV_AUTH_BYPASS || "false";

// Rate limit store fallback for test mode
process.env.RATE_LIMIT_STORE = process.env.RATE_LIMIT_STORE || "memory";

// AI Provider mock keys
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "placeholder-gemini-test-key";
process.env.FAL_KEY = process.env.FAL_KEY || "placeholder-fal-test-key";
process.env.HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY || "placeholder-hf-test-key";

// Hermetic In-Memory Storage & Run Repository Mocking
const { supabase, supabaseAdmin } = await import("../lib/supabase.js");
const { RunRepository } = await import("../src/v2/runner/runRepository.js");
const { WorkflowMediaRepository } = await import("../src/db/WorkflowMediaRepository.js");

RunRepository.useMemoryFallback = true;
WorkflowMediaRepository.enableTestMemoryFallback();

const inMemoryStorage = new Map();
const mockStorageBucket = {
  upload: async (cleanPath, payload, options) => {
    inMemoryStorage.set(cleanPath, payload);
    return { data: { path: cleanPath }, error: null };
  },
  getPublicUrl: (cleanPath) => {
    return { data: { publicUrl: `https://mock-storage.local/${cleanPath}` } };
  },
  remove: async (paths) => {
    for (const p of paths) inMemoryStorage.delete(p);
    return { data: paths, error: null };
  },
};

const mockStorageClient = {
  from: () => mockStorageBucket,
};

if (supabase) {
  supabase.storage = mockStorageClient;
}
if (supabaseAdmin) {
  supabaseAdmin.storage = mockStorageClient;
}


