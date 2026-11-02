/**
 * Storage Business System Entry File (Rule 3)
 *
 * Public surface:
 * - StorageService: Canonical storage facade class
 * - StorageError, StorageValidationError: System error hierarchy (Rule 8)
 * - InMemoryStorageProvider: In-memory provider (Test-Only, OD-STOR-4)
 */

export { StorageService } from "./StorageService.js";
export { StorageError, StorageValidationError } from "./StorageErrors.js";

// InMemoryStorageProvider: In-memory provider (Test-Only, OD-STOR-4)
export { InMemoryStorageProvider } from "./providers/InMemoryStorageProvider.js";

// TODO (Transitional): Retained for tests/unit/storageServiceContract.test.js.
// Migrate tests to internal relative imports or test harnesses in Phase 2.2b-2 before pruning.
export { StoragePathResolver, storagePathResolver } from "./StoragePathResolver.js";
export { IStorageProvider } from "./IStorageProvider.js";
export { SupabaseStorageProvider } from "./providers/SupabaseStorageProvider.js";
