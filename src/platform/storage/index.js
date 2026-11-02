/**
 * Storage Business System Entry File (Rule 3)
 *
 * Public surface:
 * - StorageService: Canonical storage facade class
 * - StorageError, StorageValidationError: System error hierarchy (Rule 8)
 * - InMemoryStorageProvider: In-memory provider (Test-Only, OD-STOR-4)
 */

export { StorageService } from "./StorageService.js";
export { createStorageService } from "./storageFactory.js";
export { StorageError, StorageValidationError } from "./StorageErrors.js";

// InMemoryStorageProvider: In-memory provider (Test-Only, OD-STOR-4)
export { InMemoryStorageProvider } from "./providers/InMemoryStorageProvider.js";
