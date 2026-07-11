# First Slice Selection

## Image Workflow Candidate

- Feature: image generation
- Legacy route: `apiOpenArt/routes/images.js`
- Legacy controller: `apiOpenArt/controllers/imageController.js`
- Legacy treatment: `GenerateImageTreatment`
- Target registry entry: `first-slice-image-generation`
- Target workflow: `first-slice-image-generation`

## Video Workflow Candidate

- Feature: video generation
- Legacy route: `apiOpenArt/routes/video.js`
- Legacy controller: `apiOpenArt/controllers/videoController.js`
- Legacy treatment: `VideoTreatment`
- Target registry entry: `first-slice-video-generation`
- Target workflow: `first-slice-video-generation`

## Parity Rule

Strict parity must cover success behavior, key failure behavior, billing outcomes,
storage behavior, status transitions, and observable events before a legacy path is
disabled or removed.

## Approved Parity Exceptions and Behavior Changes

1. **Schema Validation Execution**: Real input schema checks and parameter type validation are now declared on the workflow definition via `inputSchemaId` and evaluated inside processing steps, rather than manually parsed on Express request objects.
2. **Provider Selection decoupling**: Hardcoded provider endpoints in legacy routes are replaced with automatic routing through the provider resolver using health, cost, and latency metrics. Legacy fallback logic is replaced with the centralized resolver failover chain.
3. **Billing Rollback synchronization**: Any failure in workflow execution, storage persistence, or queue enqueueing triggers automatic billing rollback instantly via the centralized WorkflowRunner's transaction lifecycle event registry.

