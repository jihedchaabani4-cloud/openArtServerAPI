# Queue Layer Note

`src/services/jobQueueService.js` is the canonical UseCase job queue manager.

Files in this directory are platform-level queue/Redis primitives or legacy queue
helpers. New UseCase dispatch code should go through:

- `src/services/jobQueueService.js`
- `src/services/useCaseService.js`
- `src/workers/useCaseWorker.js`

Do not add new product-specific queue entrypoints here.
