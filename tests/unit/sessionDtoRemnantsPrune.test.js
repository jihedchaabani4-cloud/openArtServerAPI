import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProjectReadService } from "#workspace/tools";
import { toAssetDto } from "#shared";
import { WorkflowRepository } from "#generation/tools";
import { WorkflowMediaRepository } from "#media/tools";
import { supabase, supabaseAdmin } from "#shared/db/supabase.js";

describe("Ticket 02: Legacy Session DTO & Repository Remnants Pruning", () => {
  it("ProjectReadService.getProjectData does NOT return sessions or metadata.sessionId", async () => {
    const projectId = "00000000-0000-4000-a000-000000000001";
    const userId = "00000000-0000-4000-a000-000000000002";
    const workflowId = "00000000-0000-4000-a000-000000000010";

    const mockDb = {
      workflows: {
        findByProject: async () => [
          {
            id: workflowId,
            display_name: "Workflow 1",
            create_time: "2026-01-01T00:00:00Z",
            workflow_type: "GENERATION",
            folder_id: null,
            favorited: false,
          },
        ],
      },
      characters: { findByProject: async () => [] },
      elements: { findByProject: async () => [] },
    };

    const origFrom = supabase.from;
    const origAdminFrom = supabaseAdmin.from;

    const mockFrom = (table) => {
      if (table === "project") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: projectId, user_id: userId, project_name: "Session Clean Project" },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "media" || table === "workflow_media") {
        return {
          select: () => ({
            eq: () => ({ order: async () => ({ data: [], error: null }) }),
            in: async () => ({ data: [], error: null }),
          }),
        };
      }
      if (table === "element" || table === "characters") {
        return {
          select: () => ({
            in: async () => ({ data: [], error: null }),
            eq: async () => ({ data: [], error: null }),
            or: async () => ({ data: [], error: null }),
          }),
        };
      }
      return origFrom.call(supabase, table);
    };

    try {
      supabase.from = mockFrom;
      supabaseAdmin.from = mockFrom;

      const service = new ProjectReadService({ db: mockDb });
      const data = await service.getProjectData({ projectId, userId });

      // Verify top-level return object
      assert.equal("sessions" in data, false, "getProjectData MUST NOT include sessions property");
      assert.ok(Array.isArray(data.workflows), "workflows array must be present");
      assert.equal(data.workflows.length, 1);

      // Verify workflow metadata
      const wf = data.workflows[0];
      assert.ok(wf.metadata, "workflow metadata must be present");
      assert.equal(
        "sessionId" in wf.metadata,
        false,
        "workflow.metadata MUST NOT contain sessionId"
      );
    } finally {
      supabase.from = origFrom;
      supabaseAdmin.from = origAdminFrom;
    }
  });

  it("toAssetDto resolves primaryMediaId from canonical relation and omits sessionId", () => {
    // 1. Workflow with primaryMediaId already resolved from canonical workflow_media
    const workflowWithCanonicalRelation = {
      id: "wf-123",
      project_id: "p-456",
      user_id: "u-789",
      folder_id: null,
      display_name: "Canonical Asset",
      session_id: "sess-legacy-999",
      primaryMediaId: "media-canonical-primary-pinned",
      primary_media_id: null,
      workflow_type: "UPLOAD",
      favorited: true,
      create_time: "2026-01-01T00:00:00Z",
      update_time: "2026-01-01T00:00:00Z",
    };

    const dto1 = toAssetDto(workflowWithCanonicalRelation);
    assert.ok(dto1, "Asset DTO must be created");
    assert.equal(dto1.id, "wf-123");
    assert.equal(dto1.name, "Canonical Asset");
    assert.equal(
      dto1.primaryMediaId,
      "media-canonical-primary-pinned",
      "toAssetDto must resolve primaryMediaId from canonical relation (workflow.primaryMediaId)"
    );
    assert.equal("sessionId" in dto1, false, "toAssetDto MUST NOT include sessionId in output");

    // 2. Workflow with legacy column only (fallback removed: must return null)
    const workflowWithLegacyColumn = {
      id: "wf-456",
      project_id: "p-456",
      user_id: "u-789",
      display_name: "Legacy Asset",
      primary_media_id: "media-legacy-pin",
      workflow_type: "GENERATION",
    };

    const dto2 = toAssetDto(workflowWithLegacyColumn);
    assert.equal(
      dto2.primaryMediaId,
      null,
      "toAssetDto must NOT fall back to legacy primary_media_id and must rely exclusively on canonical primaryMediaId"
    );

    // 3. Workflow without primary media
    const workflowWithoutPrimary = {
      id: "wf-789",
      project_id: "p-456",
      display_name: "Unpinned Asset",
    };

    const dto3 = toAssetDto(workflowWithoutPrimary);
    assert.equal(dto3.primaryMediaId, null, "toAssetDto must set primaryMediaId to null if unpinned");
  });

  it("WorkflowRepository does NOT expose findBySession and findByProjectsPaginated ignores sessionId", async () => {
    const repo = new WorkflowRepository();

    // Verify dead method removed
    assert.equal(
      typeof repo.findBySession,
      "undefined",
      "WorkflowRepository.findBySession must be completely removed"
    );

    const origClient = repo.client;
    let countFilters = [];

    try {
      repo.client = () => ({
        from: (table) => ({
          select: (cols, opts) => {
            if (table === "trash" || (cols === "id" && !opts?.count)) {
              return {
                in: async () => ({ data: [], error: null }),
              };
            }
            if (opts?.count) {
              return {
                in: () => ({
                  count: 0,
                  error: null,
                  eq: (col, val) => {
                    countFilters.push({ col, val });
                    return { count: 0, error: null };
                  },
                }),
              };
            }
            return {
              in: () => ({
                order: () => ({
                  range: async () => ({ data: [], error: null }),
                }),
              }),
            };
          },
        }),
      });

      await repo.findByProjectsPaginated(["proj-1"], { sessionId: "sess-ignored" });
      assert.equal(
        countFilters.some((f) => f.col === "session_id"),
        false,
        "findByProjectsPaginated must not apply session_id filter"
      );
    } finally {
      repo.client = origClient;
    }
  });

  it("regression: getUserLibrary and listProjectAssets resolve primary media from canonical workflow_media into toAssetDto", async () => {
    const { GenerationService } = await import("#generation/tools");

    const testWfId = "00000000-0000-4000-a000-000000000099";
    const primaryMediaId = "00000000-0000-4000-a000-000000000077";
    const secondaryMediaId = "00000000-0000-4000-a000-000000000088";
    const testProjectId = "00000000-0000-4000-a000-000000000001";
    const testUserId = "user-hermetic-library";

    // DB mock simulating:
    // 1) workflow table WITHOUT primary_media_id column
    // 2) workflow_media table containing canonical is_primary relation
    const mockDb = {
      projects: {
        findByUser: async (uid, pid) => [{ id: testProjectId, user_id: uid }],
      },
      workflows: {
        // Raw repository result: NO primary_media_id column present
        findByProjectsPaginated: async () => ({
          workflows: [
            {
              id: testWfId,
              project_id: testProjectId,
              user_id: testUserId,
              display_name: "Hermetic Library Workflow",
              favorited: true,
              workflow_type: "GENERATION",
              create_time: "2026-01-01T12:00:00Z",
              // Note: primary_media_id is NOT in the database row!
            },
          ],
          total: 1,
        }),
        listProjectAssets: async () => [
          {
            id: testWfId,
            project_id: testProjectId,
            user_id: testUserId,
            display_name: "Hermetic Asset Workflow",
            favorited: true,
            workflow_type: "GENERATION",
            create_time: "2026-01-01T12:00:00Z",
          },
        ],
      },
      workflowMedia: {
        // Canonical relationship table has the primary link
        findByWorkflowIds: async (wfIds) => {
          assert.deepEqual(wfIds, [testWfId]);
          return [
            {
              id: secondaryMediaId,
              workflow_id: testWfId,
              workflowId: testWfId,
              role: "output",
              is_primary: false,
              isPrimary: false,
              url: "https://cdn.example.com/secondary.png",
              width: 512,
              height: 512,
              created_at: "2026-01-01T12:00:01Z",
            },
            {
              id: primaryMediaId,
              workflow_id: testWfId,
              workflowId: testWfId,
              role: "output",
              is_primary: true,
              isPrimary: true,
              url: "https://cdn.example.com/canonical-primary.png",
              width: 1024,
              height: 1024,
              created_at: "2026-01-01T12:00:02Z",
            },
          ];
        },
      },
      media: {
        findByIds: async () => [],
      },
      configs: {
        findByIdsWithReferences: async () => [],
      },
      folders: {
        findOwnedInProject: async () => null,
      },
    };

    const service = new GenerationService({ db: mockDb });

    // 1. Trace getUserLibrary -> findByProjectsPaginated -> #buildLibraryPayload
    const libraryResult = await service.getUserLibrary(testUserId, { projectId: testProjectId });
    assert.equal(libraryResult.data.length, 1);
    const libraryEntry = libraryResult.data[0];

    // Verify canonical primary media is resolved in library entry
    assert.ok(libraryEntry.primary_media, "primary_media must be resolved in library payload");
    assert.equal(libraryEntry.primary_media.id, primaryMediaId);
    assert.equal(libraryEntry.primary_media.url, "https://cdn.example.com/canonical-primary.png");
    assert.equal(libraryEntry.workflow.primaryMediaId, primaryMediaId);

    // Feed the resulting workflow directly into toAssetDto
    const libraryAssetDto = toAssetDto(libraryEntry.workflow);
    assert.equal(libraryAssetDto.id, testWfId);
    assert.equal(
      libraryAssetDto.primaryMediaId,
      primaryMediaId,
      "toAssetDto must receive the canonical primaryMediaId resolved by getUserLibrary"
    );
    assert.equal("sessionId" in libraryAssetDto, false);

    // 2. Trace listProjectAssets -> listProjectAssets DB -> canonical relation bulk fetch -> toAssetDto
    const assetListingResult = await service.listProjectAssets({
      userId: testUserId,
      projectId: testProjectId,
    });
    assert.equal(assetListingResult.items.length, 1);
    const assetDto = assetListingResult.items[0];

    assert.equal(assetDto.id, testWfId);
    assert.equal(
      assetDto.primaryMediaId,
      primaryMediaId,
      "listProjectAssets must bulk-resolve primaryMediaId from workflow_media for toAssetDto"
    );
    assert.equal("sessionId" in assetDto, false);
  });

  it("listProjectAssets error propagation: propagates and reports workflowMedia query failure without swallowing", async () => {
    const { GenerationService } = await import("#generation/tools");

    const mockDb = {
      projects: {
        findByUser: async () => [{ id: "proj-err", user_id: "user-err" }],
      },
      workflows: {
        listProjectAssets: async () => [
          {
            id: "wf-err-1",
            project_id: "proj-err",
            user_id: "user-err",
            display_name: "Workflow With DB Failure",
            create_time: "2026-01-01T12:00:00Z",
          },
        ],
      },
      workflowMedia: {
        findByWorkflowIds: async () => {
          throw new Error("DATABASE_CONNECTION_REFUSED: workflow_media replica unreachable");
        },
      },
      folders: {
        findOwnedInProject: async () => null,
      },
    };

    const service = new GenerationService({ db: mockDb });

    await assert.rejects(
      async () => {
        await service.listProjectAssets({ userId: "user-err", projectId: "proj-err" });
      },
      {
        message: "DATABASE_CONNECTION_REFUSED: workflow_media replica unreachable",
      },
      "listProjectAssets must rethrow/propagate workflowMedia database failure"
    );
  });

  it("real WorkflowMediaRepository.findByWorkflowIds contract: transforms canonical relation and joined media into domain objects for GenerationService", async () => {
    const { GenerationService } = await import("#generation/tools");

    const targetWorkflowId = "00000000-0000-4000-a000-000000000111";
    const primaryMediaId = "00000000-0000-4000-a000-000000000777";
    const detailMediaId = "00000000-0000-4000-a000-000000000888";
    const targetProjectId = "00000000-0000-4000-a000-000000000001";
    const targetUserId = "user-real-contract";

    // 1. Mock raw Supabase client returning raw relational rows joined with media
    const mockSupabaseQuery = {
      from: (table) => {
        assert.equal(table, "workflow_media");
        return {
          select: (columns) => {
            assert.match(columns, /workflow_id/);
            assert.match(columns, /media:media_id/);
            return {
              in: (col, ids) => {
                assert.equal(col, "workflow_id");
                assert.deepEqual(ids, [targetWorkflowId]);
                return {
                  order: (orderCol, orderOpts) => {
                    assert.equal(orderCol, "created_at");
                    return {
                      // Returns raw relational rows with joined media object from Postgres
                      data: [
                        {
                          workflow_id: targetWorkflowId,
                          media_id: primaryMediaId,
                          role: "sheet",
                          is_primary: true,
                          metadata: { customRole: "cover" },
                          created_at: "2026-01-01T10:00:00.000Z",
                          media: {
                            id: primaryMediaId,
                            step_id: "character_sheet",
                            url: "https://storage.local/canonical-primary-sheet.png",
                            width: 1024,
                            height: 1024,
                            status: "success",
                            error_message: null,
                            create_time: "2026-01-01T10:00:00.000Z",
                          },
                        },
                        {
                          workflow_id: targetWorkflowId,
                          media_id: detailMediaId,
                          role: "detail",
                          is_primary: false,
                          metadata: {},
                          created_at: "2026-01-01T10:05:00.000Z",
                          media: {
                            id: detailMediaId,
                            step_id: "character_detail",
                            url: "https://storage.local/detail-photo.png",
                            width: 512,
                            height: 512,
                            status: "success",
                            error_message: null,
                            create_time: "2026-01-01T10:05:00.000Z",
                          },
                        },
                      ],
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      },
    };

    // 2. Instantiate REAL WorkflowMediaRepository and wire client
    const realRepo = new WorkflowMediaRepository();
    realRepo.client = () => mockSupabaseQuery;

    // 3. Test real repository method directly
    const repoRows = await realRepo.findByWorkflowIds([targetWorkflowId]);
    assert.equal(repoRows.length, 2, "Real repository must return 2 mapped rows");

    // Verify row mapping transformation contract
    const primaryRow = repoRows.find((r) => r.is_primary);
    assert.ok(primaryRow, "Primary relation must be found in repo output");
    assert.equal(primaryRow.id, primaryMediaId, "id must map to joined media.id");
    assert.equal(primaryRow.media_id, primaryMediaId, "media_id must match canonical relation");
    assert.equal(primaryRow.mediaId, primaryMediaId, "mediaId must match canonical relation");
    assert.equal(primaryRow.workflow_id, targetWorkflowId, "workflow_id must match relation");
    assert.equal(primaryRow.workflowId, targetWorkflowId, "workflowId must match relation");
    assert.equal(primaryRow.role, "sheet", "role must be preserved from relation");
    assert.equal(primaryRow.mediaRole, "sheet", "mediaRole must match relation role");
    assert.equal(primaryRow.is_primary, true, "is_primary must be true");
    assert.equal(primaryRow.isPrimary, true, "isPrimary must be true");
    assert.equal(primaryRow.url, "https://storage.local/canonical-primary-sheet.png");
    assert.equal(primaryRow.width, 1024);
    assert.equal(primaryRow.height, 1024);
    assert.equal(primaryRow.status, "success");
    assert.equal(primaryRow.workflow_media_created_at, "2026-01-01T10:00:00.000Z");

    // 4. Pass REAL repository instance into GenerationService
    const mockDb = {
      projects: {
        findByUser: async (uid, pid) => [{ id: targetProjectId, user_id: uid }],
      },
      workflows: {
        findByProjectsPaginated: async () => ({
          workflows: [
            {
              id: targetWorkflowId,
              project_id: targetProjectId,
              user_id: targetUserId,
              display_name: "Workflow With Real Repo",
              favorited: true,
              workflow_type: "GENERATION",
              create_time: "2026-01-01T12:00:00Z",
            },
          ],
          total: 1,
        }),
        listProjectAssets: async () => [
          {
            id: targetWorkflowId,
            project_id: targetProjectId,
            user_id: targetUserId,
            display_name: "Asset With Real Repo",
            favorited: true,
            workflow_type: "GENERATION",
            create_time: "2026-01-01T12:00:00Z",
          },
        ],
      },
      workflowMedia: realRepo, // Real repository instance!
      folders: { findOwnedInProject: async () => null },
    };

    const service = new GenerationService({ db: mockDb });

    // 5. Test getUserLibrary uses real contract and resolves correct primary media
    const libraryResult = await service.getUserLibrary(targetUserId, { projectId: targetProjectId });
    assert.equal(libraryResult.data.length, 1);
    const libEntry = libraryResult.data[0];

    assert.equal(
      libEntry.workflow.primaryMediaId,
      primaryMediaId,
      "getUserLibrary must map primaryMediaId from real repository contract"
    );
    assert.ok(libEntry.primary_media, "primary_media must be resolved in library entry");
    assert.equal(libEntry.primary_media.id, primaryMediaId);
    assert.equal(libEntry.primary_media.url, "https://storage.local/canonical-primary-sheet.png");

    // 6. Test listProjectAssets -> toAssetDto using real repository
    const assetListing = await service.listProjectAssets({
      projectId: targetProjectId,
      userId: targetUserId,
    });
    assert.equal(assetListing.items.length, 1);
    const assetDto = assetListing.items[0];

    assert.equal(
      assetDto.primaryMediaId,
      primaryMediaId,
      "listProjectAssets must set primaryMediaId from real repository contract"
    );
    assert.equal("sessionId" in assetDto, false);
    assert.equal("primary_media_id" in assetDto, false);
  });

  it("listProjectAssets dependency failure: throws DEPENDENCY_ERROR when workflowMedia repository method is unavailable", async () => {
    const { GenerationService } = await import("#generation/tools");

    const serviceWithoutRepo = new GenerationService({
      db: {
        projects: {
          findByUser: async (uid, pid) => [{ id: "00000000-0000-4000-a000-000000000001", user_id: uid }],
        },
        workflows: {
          listProjectAssets: async () => [
            {
              id: "wf-dep-1",
              project_id: "00000000-0000-4000-a000-000000000001",
              user_id: "user-1",
              display_name: "Asset Without Repo",
            },
          ],
        },
        workflowMedia: {}, // Missing findByWorkflowIds
        folders: { findOwnedInProject: async () => null },
      },
    });

    await assert.rejects(
      async () => {
        await serviceWithoutRepo.listProjectAssets({
          projectId: "00000000-0000-4000-a000-000000000001",
          userId: "user-1",
        });
      },
      (err) => {
        assert.equal(err.statusCode, 500, "Must return HTTP 500");
        assert.equal(err.errorCode, "DEPENDENCY_ERROR", "Must return DEPENDENCY_ERROR errorCode");
        assert.match(err.message, /WorkflowMedia repository is unavailable/);
        return true;
      },
      "listProjectAssets must explicitly fail when workflowMedia repository is missing"
    );
  });
});
