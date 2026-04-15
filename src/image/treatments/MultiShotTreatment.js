// src/treatments/MultiShotTreatment.js
import { uploadReferenceAssetToStorage } from "../utils/uploadReferenceAsset.js";
export class MultiShotTreatment {
    /**
     * @param {Object} deps
     * @param {import('../services/PromptService').PromptService} deps.promptService
     * @param {Object} deps.models
     * @param {import('../services/StorageService').StorageService} deps.storageService
     * @param {import('../repositories/GenerationRepository').GenerationRepository} deps.db
     */
    constructor({ promptService, models, storageService, db }) {
        this.promptService = promptService;
        this.models = models;
        this.storageService = storageService;
        this.db = db;
    }

    /**
     * @param {Object} input
     * @param {string} input.userPlan
     * @param {string} input.model_name
     * @param {string} input.prompt          - base prompt
     * @param {string} input.negative_prompt
     * @param {Object[]} input.references    - input assets
     * @param {number} input.count           - عدد الصور
     * @param {string} input.session_id
     * @param {string} input.project_id
     * @param {number} input.strength
     * @param {number} input.steps
     * @param {number} input.guidance_scale
     * @param {number} input.seed
     * @param {string} input.ratio
     * @param {string} input.quality
     */
    async execute(input) {
        const {
            userPlan = "free",
            model_name = "sdxl",
            prompt = "",
            negative_prompt = "",
            references = [],
            session_id,
            project_id,
            strength = 0.7,
            steps,
            guidance_scale,
            seed,
            ratio,
            quality,
        } = input;

        const count = Math.max(1, Math.min(input.count || 1, 10));
        const userId = 'e54d7d5f-9c49-457d-83b7-ac8484bceb80'; // TODO: من الـ auth
        const startTime = Date.now();

        // 1. اختار الـ provider
        const provider = this.models[model_name] || this.models["sdxl"];

        // 2. بناء input_assets من references
        const input_assets = await this._buildInputAssets(references, userId, project_id, session_id);

        // 3. الـ AI يولد prompts مختلفة حسب الـ count
        const generatedPrompts = await this.promptService.generateSceneVariations(prompt, count);

        // 4. createGroup
        const group = await this.db.createGroup({
            created_by: userId,
            session_id,
            type: 'multi_shot',
            section: 'image_generator',
            model: `${model_name}-${userPlan}`,
            params: {
                base_prompt: prompt,
                prompts: generatedPrompts,
                negative_prompt,
                ratio,
                quality,
                strength,
                steps,
                guidance_scale,
                seed,
                count,
                project_id,
            },
            input_assets
        });

        // 5. createItems — كل item عنده prompt خاص بيه
        const itemIds = [];
        for (let i = 0; i < count; i++) {
            const item = await this.db.createItem({
                group_id: group.id,
                prompt: generatedPrompts[i],
                index: i,
                params: { ratio, quality, strength, seed }
            });
            itemIds.push(item.id);
        }

        // 6. شغل الـ background
        this._runBackground({
            provider,
            groupId: group.id,
            itemIds,
            prompts: generatedPrompts,
            negative_prompt,
            input_assets,
            strength,
            steps,
            guidance_scale,
            seed,
            ratio,
            quality,
            userId,
            project_id,
            session_id,
            startTime,
            count
        }).catch(async err => {
            console.error(`❌ [MultiShotTreatment] Error: ${err.message}`);
            for (const itemId of itemIds) {
                await this.db.updateItemStatus({
                    item_id: itemId,
                    status: 'error',
                    error_message: err.message
                });
            }
        });

        return {
            groupId: group.id,
            itemIds,
            status: 'processing',
            count,
            prompts: generatedPrompts
        };
    }

    // ─────────────────────────────────────────
    async _runBackground({
        provider, groupId, itemIds, prompts,
        negative_prompt, input_assets, strength,
        steps, guidance_scale, seed, ratio, quality,
        userId, project_id, session_id, startTime, count
    }) {

        // 1. جيب الـ source image لو موجودة
        const sourceAsset = input_assets.find(a => a.role === 'source' && a.type === 'image_url');
        const image_url = sourceAsset?.url;

        // 2. safety check على الـ base prompt
        const safety = await this.promptService.checkPrompt(prompts[0]);
        if (!safety.safe) {
            for (const itemId of itemIds) {
                await this.db.updateItemStatus({
                    item_id: itemId,
                    status: 'rejected',
                    error_message: safety.reason
                });
            }
            return;
        }

        // 3. enhance كل prompt
        const enhancedPrompts = await Promise.all(
            prompts.map(p => this.promptService.upscalePrompt(p, { quality }))
        );

        const autoNegative = await this.promptService.generateNegativePrompt(enhancedPrompts[0].enhanced);
        const finalNegative = [negative_prompt, autoNegative].filter(Boolean).join(", ");

        // 4. generate كل shot لوحده
        for (let i = 0; i < count; i++) {
            try {
                const enhancedPrompt = enhancedPrompts[i].enhanced;
                const currentItemId = itemIds[i];
                const suggestedSteps = steps || enhancedPrompts[i].suggestedParams?.steps;
                const suggestedGuidance = guidance_scale || enhancedPrompts[i].suggestedParams?.guidanceScale;

                let result;
                const form = {
                    prompt: enhancedPrompt,
                    negativePrompt: finalNegative,
                    ratio, quality, steps: suggestedSteps, guidanceScale: suggestedGuidance, seed,
                    image: image_url,
                    references: image_url ? [{ url: image_url, role: "start" }] : []
                };

                const adapted = provider.adapt(form);
                const payload = provider.toPayload(adapted);
                result = await provider.generate(payload);

                // 5. رفع لـ Storage
                const fileName = `${userId}/generations/${groupId}_${i + 1}.jpg`;
                const fileUrl = await this.storageService.upload(fileName, result.image_base64);

                // 6. حفظ في media_assets
                const assetId = await this.db.createAsset({
                    project_id,
                    session_id,
                    userId,
                    asset_type: 'generated',
                    media_type: 'image',
                    file_url: fileUrl,
                    file_path: fileName,
                    mime_type: 'image/jpeg'
                });

                await this.db.updateSessionCoverIfEmpty(session_id, assetId);

                // 7. تحديث الـ item
                await this.db.updateItemStatus({
                    item_id: currentItemId,
                    status: 'completed',
                    asset_id: assetId,
                    duration_ms: Date.now() - startTime
                });

                console.log(`✅ [MultiShot] Shot ${i + 1}/${count} done — ${enhancedPrompt}`);

            } catch (err) {
                // لو shot واحد فشل — ما نوقفش الباقي
                console.error(`❌ [MultiShot] Shot ${i + 1} failed: ${err.message}`);
                await this.db.updateItemStatus({
                    item_id: itemIds[i],
                    status: 'error',
                    error_message: err.message
                });
            }
        }

        console.log(`🎬 [MultiShot] Group ${groupId} finished — ${count} shots`);
    }

    // ─────────────────────────────────────────
    // HELPER — build input_assets من references
    // ─────────────────────────────────────────
    async _buildInputAssets(references, userId, project_id, session_id) {
        if (!references?.length) return [];

        return Promise.all(references.map(async (ref) => {

            // upload من PC — base64
            if (ref.file || ref.base64) {
                return uploadReferenceAssetToStorage({
                    storageService: this.storageService,
                    db: this.db,
                    base64: ref.file || ref.base64,
                    userId,
                    project_id,
                    session_id,
                    role: ref.role,
                });
            }

            // URL مباشر
            if (ref.url) {
                return {
                    role: ref.role,
                    type: 'image_url',
                    url: ref.url
                };
            }

            // generated asset موجود في DB
            if (ref.asset_id) {
                const asset = await this.db.getAssetById(ref.asset_id);
                return {
                    role: ref.role,
                    type: 'image_url',
                    url: asset.file_url,
                    asset_id: asset.id
                };
            }

            // entity (character، style، location...)
            if (ref.entity_id) {
                return {
                    role: ref.role,
                    type: 'entity',
                    entity_id: ref.entity_id,
                    entity_type: ref.entity_type
                };
            }

            throw new Error(`Invalid reference: ${JSON.stringify(ref)}`);
        }));
    }
}