import express from 'express';
import healthRouter from '../../routes/health.js';
import workspacesRouter from '../../routes/workspaces.js';
import workflowsRouter from '../../routes/workflows.js';
import videoRouter from '../../routes/video.js';
import audioRouter from '../../routes/audio.js';
import imagesRouter from '../../routes/images.js';
import visionRouter from '../../routes/vision.js';
import elementsRouter from '../../routes/elements.js';
import elementSheetRouter from '../../routes/elementSheet.js';
import projectsRouter from '../../routes/projects.js';
import sessionsRouter from '../../routes/sessions.js';
import modelsRouter  from '../../routes/modelsRoute.js';
import assetsRouter  from '../../routes/assets.js';
import cameraRouter   from '../../routes/camera.js';
import lightingRouter from '../../routes/lighting.js';
import mediaRouter    from '../../routes/media.js';

const router = express.Router();

router.use('/health', healthRouter);
router.use('/workspaces', workspacesRouter);
router.use('/workflows', workflowsRouter);
router.use('/video',   videoRouter);
router.use('/audio', audioRouter);
router.use('/images', imagesRouter);
router.use('/vision', visionRouter);
router.use('/elements', elementsRouter);
router.use('/element-sheet', elementSheetRouter);
router.use('/projects', projectsRouter);
router.use('/sessions', sessionsRouter);
router.use('/models',   modelsRouter);
router.use('/assets',   assetsRouter);
router.use('/camera',   cameraRouter);
router.use('/lighting', lightingRouter);
router.use('/media',    mediaRouter);

export default router;
