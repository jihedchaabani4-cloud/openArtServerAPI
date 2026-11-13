/**
 * Main Central Routing Aggregator
 *
 * Exclusively mounts HTTP routers from the 8 Business Systems' public/api.js gateways:
 * 1. #generation/api (images, video, prompt, v2/workflows, workflows)
 * 2. #models/api (models)
 * 3. #billing/api (payments, wallet, admin)
 * 4. #media/api (media, assets)
 * 5. #identity/api (auth)
 * 6. #characters/api (characters)
 * 7. #elements/api (v2/elements)
 * 8. #workspace/api (projects, folders, trash)
 *
 * Plus system-wide liveness and readiness probes (/health, /ready).
 *
 * Governed by:
 * - docs/architecture/constitution/01_business_systems_architecture.md
 * - docs/architecture/constitution/02_architecture_rules_and_agent_guardrails.md (Rule 1, Rule 10, Rule 13)
 */

import express from 'express';

// System 1: Generation & Workflows (#generation/api)
import {
    imagesRouter,
    videoRouter,
    promptRouter,
    v2WorkflowsRouter,
    workflowsRouter,
} from '#generation/api';

// System 2: Models Management (#models/api)
import { modelsRouter } from '#models/api';

// System 3: Billing & Wallet (#billing/api)
import {
    paymentsRouter,
    walletRouter,
    adminRouter,
} from '#billing/api';

// System 4: Media & Storage (#media/api)
import {
    mediaIngestRouter,
    assetsRouter,
} from '#media/api';

// System 5: Identity & Auth (#identity/api)
import { authRouter } from '#identity/api';

// System 6: Characters (#characters/api)
import { charactersRouter } from '#characters/api';

// System 7: Elements (#elements/api)
import { elementRoutes } from '#elements/api';

// System 8: Workspace (#workspace/api)
import {
    projectsRouter,
    foldersRouter,
    trashRouter,
} from '#workspace/api';

// System-wide Infrastructure Probes
import healthRouter from '../../routes/health.js';
import readyRouter from '../../routes/ready.js';

const router = express.Router();

// ── System 4: Media ──────────────────────────────────────────────────────────
router.use('/media',        mediaIngestRouter);

// ── System 5: Identity ───────────────────────────────────────────────────────
router.use('/auth',         authRouter);

// ── Probes ───────────────────────────────────────────────────────────────────
router.use('/health',       healthRouter);
router.use('/ready',        readyRouter);

// ── System 1: Generation & Workflows ─────────────────────────────────────────
router.use('/workflows',    workflowsRouter);
router.use('/images',       imagesRouter);
router.use('/video',        videoRouter);

// ── System 6: Characters ─────────────────────────────────────────────────────
router.use('/characters',   charactersRouter);

// ── System 8: Workspace ──────────────────────────────────────────────────────
router.use('/projects',     projectsRouter);
router.use('/folders',      foldersRouter);

// ── System 2: Models Management ──────────────────────────────────────────────
router.use('/models',       modelsRouter);

// ── System 4: Assets (Media System) ──────────────────────────────────────────
router.use('/assets',       assetsRouter);

// ── System 1: Prompt Optimization (Generation System) ────────────────────────
router.use('/prompt',       promptRouter);

// ── System 3: Billing & Wallet ───────────────────────────────────────────────
router.use('/payments',     paymentsRouter);
router.use('/wallet',       walletRouter);
router.use('/admin',        adminRouter);

// ── System 1: V2 Workflows (Generation System) ───────────────────────────────
router.use('/v2/workflows', v2WorkflowsRouter);

// ── System 7: Elements ───────────────────────────────────────────────────────
router.use('/v2/elements',  elementRoutes);

// ── System 8: Trash (Workspace System) ───────────────────────────────────────
router.use('/trash',        trashRouter);

export default router;
