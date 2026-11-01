process.env.NODE_ENV = "test";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CharacterMediaService } from "../../src/domain/character/CharacterMediaService.js";
import { WorkflowMediaService } from "../../src/platform/workflow/WorkflowMediaService.js";

function setupBugHarness() {
    const workflows = new Map();
    const media = new Map();
    const workflowMedia = [];
    const characters = new Map();

    const db = {
        workflows: {
            getWorkflow: async (id) => workflows.get(id) || null,
            findById: async (id) => workflows.get(id) || null,
            updatePrimaryMedia: async (wfId, mediaId) => {
                const wf = workflows.get(wfId);
                if (wf) wf.primary_media_id = mediaId;
                return wf;
            },
            updateFields: async (wfId, fields) => {
                const wf = workflows.get(wfId);
                if (wf) Object.assign(wf, fields);
                return wf;
            },
        },
        characters: {
            findByCharacterId: async (id) => characters.get(id) || null,
            findById: async (id) => characters.get(id) || null,
            updateCharacterFields: async (id, fields) => {
                const c = characters.get(id);
                if (c) Object.assign(c, fields);
                return c;
            },
        },
        media: {
            findById: async (id) => media.get(id) || null,
            findMediaByIdOrWorkflow: async (id) => {
                const m = media.get(id);
                if (m) return m;
                // find latest by workflow
                const rels = workflowMedia.filter((wm) => wm.workflow_id === id);
                if (rels.length > 0) {
                    return media.get(rels[rels.length - 1].media_id) || null;
                }
                return null;
            },
            findByWorkflow: async (wfId) => {
                const rels = workflowMedia.filter((wm) => wm.workflow_id === wfId);
                return rels.map((r) => media.get(r.media_id)).filter(Boolean);
            },
            createMedia: async (fields) => {
                const id = fields.id || randomUUID();
                const record = { id, ...fields };
                media.set(id, record);
                return record;
            },
        },
        workflowMedia: {
            findByWorkflow: async (wfId) => workflowMedia.filter((wm) => wm.workflow_id === wfId),
            findByMedia: async (mediaId) => workflowMedia.filter((wm) => wm.media_id === mediaId),
            getPrimaryMedia: async (wfId) => workflowMedia.find((wm) => wm.workflow_id === wfId && wm.is_primary === true) || null,
            attachReferenceMedia: async ({ workflowId, mediaId, role = "sheet", maxAllowed = null, autoPrimary = true }) => {
                const currentRelations = workflowMedia.filter((wm) => wm.workflow_id === workflowId && wm.role === role);
                const existing = currentRelations.find((wm) => wm.media_id === mediaId);
                if (existing) {
                    return { workflow_id: workflowId, media_id: mediaId, role, is_primary: Boolean(existing.is_primary), is_existing: true };
                }
                const is_primary = autoPrimary ? !workflowMedia.some((wm) => wm.workflow_id === workflowId && wm.is_primary === true) : false;
                const link = { workflow_id: workflowId, media_id: mediaId, role, is_primary, created_at: new Date().toISOString() };
                workflowMedia.push(link);
                return { workflow_id: workflowId, media_id: mediaId, role, is_primary, is_existing: false };
            },
            setPrimaryMedia: async ({ workflowId, mediaId }) => {
                for (const wm of workflowMedia) {
                    if (wm.workflow_id === workflowId) {
                        wm.is_primary = wm.media_id === mediaId;
                    }
                }
                return { workflow_id: workflowId, media_id: mediaId, is_primary: true };
            },
        },
    };

    const authService = {
        verifyWorkflowOwnership: async (wfId, userId) => {
            const wf = workflows.get(wfId);
            return wf ? wf.user_id === userId : false;
        },
        verifyMediaOwnership: async (mediaId, userId) => {
            const m = media.get(mediaId);
            return m ? m.user_id === userId : false;
        },
    };

    const mediaUploadService = {
        upload: async () => ({ uploaded: [] }),
        discard: async () => ({}),
    };

    const workflowMediaService = new WorkflowMediaService({
        db,
        storageService: {},
        authService,
        mediaUploadService,
    });

    const characterMediaService = new CharacterMediaService({
        db,
        storageService: {},
        mediaUploadService,
        workflowMediaService,
        authService,
    });

    return {
        workflows,
        media,
        workflowMedia,
        characters,
        characterMediaService,
        workflowMediaService,
    };
}

describe("Character Sheet from Project Assets Reproduction", () => {
    const USER_ID = "user-123";
    const PROJECT_ID = "proj-123";
    const CHAR_WF_ID = "char-wf-001";
    const CHAR_ID = CHAR_WF_ID;

    it("Scenario A: User selects a media asset from a generation workflow (ImportMediaPopover rewrites id to workflow_id)", async () => {
        const h = setupBugHarness();

        // 1. Existing character
        h.workflows.set(CHAR_WF_ID, {
            id: CHAR_WF_ID,
            user_id: USER_ID,
            project_id: PROJECT_ID,
            workflow_type: "CHARACTER",
            primary_media_id: null,
        });
        h.characters.set(CHAR_ID, {
            id: CHAR_ID,
            workflow_id: CHAR_WF_ID,
            project_id: PROJECT_ID,
            user_id: USER_ID,
        });

        // 2. An asset in the project created by an image-gen workflow
        const GEN_WF_ID = "wf-gen-999";
        const MEDIA_ID = "media-img-888";
        h.workflows.set(GEN_WF_ID, {
            id: GEN_WF_ID,
            user_id: USER_ID,
            project_id: PROJECT_ID,
            workflow_type: "GENERATED",
            primary_media_id: MEDIA_ID,
        });
        h.media.set(MEDIA_ID, {
            id: MEDIA_ID,
            project_id: PROJECT_ID,
            url: "https://storage.example.com/gen.png",
            status: "success",
        });
        h.workflowMedia.push({
            workflow_id: GEN_WF_ID,
            media_id: MEDIA_ID,
            role: "output",
            is_primary: true,
        });

        // What ImportMediaPopover produces when user selects this asset:
        // canonicalWorkflowId = item.workflow_id -> GEN_WF_ID
        // asset.id = GEN_WF_ID
        // useCharacter selects mediaId = GEN_WF_ID (or item.id)
        // And calls CharacterMediaService.uploadSheetMedia({ characterId: CHAR_ID, mediaId: GEN_WF_ID, projectId: PROJECT_ID, userId: USER_ID })
        const res = await h.characterMediaService.uploadSheetMedia({
            characterId: CHAR_ID,
            mediaId: GEN_WF_ID,
            projectId: PROJECT_ID,
            userId: USER_ID,
        });

        assert.equal(res.ok, true);
        assert.equal(res.media.id, MEDIA_ID);
        assert.equal(res.url, "https://storage.example.com/gen.png");
    });

    it("Scenario B: User selects an uploaded project asset (role: original in workflow_media)", async () => {
        const h = setupBugHarness();

        // Existing character
        h.workflows.set(CHAR_WF_ID, {
            id: CHAR_WF_ID,
            user_id: USER_ID,
            project_id: PROJECT_ID,
            workflow_type: "CHARACTER",
            primary_media_id: null,
        });
        h.characters.set(CHAR_ID, {
            id: CHAR_ID,
            workflow_id: CHAR_WF_ID,
            project_id: PROJECT_ID,
            user_id: USER_ID,
        });

        // Uploaded project media (e.g. uploaded directly to project or imported)
        const UPLOAD_WF_ID = "wf-upload-777";
        const UPLOAD_MEDIA_ID = "media-upload-777";
        h.workflows.set(UPLOAD_WF_ID, {
            id: UPLOAD_WF_ID,
            user_id: USER_ID,
            project_id: PROJECT_ID,
            workflow_type: "UPLOAD",
            primary_media_id: UPLOAD_MEDIA_ID,
        });
        h.media.set(UPLOAD_MEDIA_ID, {
            id: UPLOAD_MEDIA_ID,
            project_id: PROJECT_ID,
            user_id: USER_ID,
            url: "https://storage.example.com/standalone.png",
            status: "success",
        });
        h.workflowMedia.push({
            workflow_id: UPLOAD_WF_ID,
            media_id: UPLOAD_MEDIA_ID,
            role: "original",
            is_primary: true,
        });

        const res = await h.characterMediaService.uploadSheetMedia({
            characterId: CHAR_ID,
            mediaId: UPLOAD_MEDIA_ID,
            projectId: PROJECT_ID,
            userId: USER_ID,
        });

        assert.equal(res.ok, true);
        assert.equal(res.media.id, UPLOAD_MEDIA_ID);
    });

    it("Scenario C: Legacy character entity in characters table with separate or null workflow_id", async () => {
        const h = setupBugHarness();

        const LEGACY_CHAR_ID = "char-legacy-entity-001";
        const LEGACY_WF_ID = "wf-container-002";

        // Character workflow exists under LEGACY_WF_ID
        h.workflows.set(LEGACY_WF_ID, {
            id: LEGACY_WF_ID,
            user_id: USER_ID,
            project_id: PROJECT_ID,
            workflow_type: "CHARACTER_SHEET",
            primary_media_id: null,
        });
        // Character row has id = LEGACY_CHAR_ID and workflow_id = LEGACY_WF_ID
        h.characters.set(LEGACY_CHAR_ID, {
            id: LEGACY_CHAR_ID,
            workflow_id: LEGACY_WF_ID,
            project_id: PROJECT_ID,
            user_id: USER_ID,
        });

        const MEDIA_ID = "media-img-555";
        const SOURCE_WF_ID = "wf-source-555";
        h.workflows.set(SOURCE_WF_ID, {
            id: SOURCE_WF_ID,
            user_id: USER_ID,
            project_id: PROJECT_ID,
            workflow_type: "UPLOAD",
            primary_media_id: MEDIA_ID,
        });
        h.media.set(MEDIA_ID, {
            id: MEDIA_ID,
            project_id: PROJECT_ID,
            user_id: USER_ID,
            url: "https://storage.example.com/legacy.png",
            status: "success",
        });
        h.workflowMedia.push({
            workflow_id: SOURCE_WF_ID,
            media_id: MEDIA_ID,
            role: "original",
            is_primary: true,
        });

        // uploadSheetMedia is invoked with characterId = LEGACY_CHAR_ID
        const res = await h.characterMediaService.uploadSheetMedia({
            characterId: LEGACY_CHAR_ID,
            mediaId: MEDIA_ID,
            projectId: PROJECT_ID,
            userId: USER_ID,
        });

        assert.equal(res.ok, true);
        assert.equal(res.media.id, MEDIA_ID);
    });
});
