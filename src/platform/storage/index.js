/**
 * Storage Business System Entry File (Rule 3)
 *
 * Public surface re-exported from Media & Storage System (#media/tools):
 * - StorageService: Canonical storage facade class
 * - StorageError, StorageValidationError: System error hierarchy (Rule 8)
 * - InMemoryStorageProvider: In-memory provider (Test-Only, OD-STOR-4)
 */

export {
    StorageService,
    createStorageService,
    StorageError,
    StorageValidationError,
    InMemoryStorageProvider,
    SupabaseStorageProvider,
    StoragePathResolver,
    storagePathResolver,
} from "#media/tools";
