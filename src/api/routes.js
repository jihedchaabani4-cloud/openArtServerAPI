import express from 'express';
import healthRouter      from '../../routes/health.js';
import workflowsRouter   from '../../routes/workflows.js';
import videoRouter       from '../../routes/video.js';
import imagesRouter      from '../../routes/images.js';
import charactersRouter from '../../routes/characters.js';
import projectsRouter    from '../../routes/projects.js';
import sessionsRouter    from '../../routes/sessions.js';
import modelsRouter      from '../../routes/modelsRoute.js';
import assetsRouter      from '../../routes/assets.js';
import cameraRouter      from '../../routes/camera.js';
import lightingRouter    from '../../routes/lighting.js';
import mediaRouter       from '../../routes/media.js';
import authRouter        from '../../routes/authRoutes.js';
import promptRouter      from '../../routes/prompt.js';
import paymentsRouter    from '../../routes/payments.js';
import walletRouter       from '../../routes/wallet.js';
import adminRouter        from '../../routes/admin.js';
import v2WorkflowsRouter  from '../../routes/v2/workflows.js';
import elementRoutes      from '../../routes/elementRoutes.js';


const router = express.Router();

router.use('/auth',            authRouter);
router.use('/health',          healthRouter);
router.use('/workflows',       workflowsRouter);
router.use('/video',           videoRouter);
router.use('/images',          imagesRouter);
router.use('/characters',      charactersRouter);
router.use('/projects',     projectsRouter);
router.use('/sessions',     sessionsRouter);
router.use('/models',       modelsRouter);
router.use('/assets',       assetsRouter);
router.use('/camera',       cameraRouter);
router.use('/lighting',     lightingRouter);
router.use('/media',        mediaRouter);
router.use('/prompt',       promptRouter);
router.use('/payments',    paymentsRouter);
router.use('/wallet',     walletRouter);
router.use('/admin',      adminRouter);
router.use('/v2/workflows', v2WorkflowsRouter);
router.use('/v2/elements',  elementRoutes);

export default router;
