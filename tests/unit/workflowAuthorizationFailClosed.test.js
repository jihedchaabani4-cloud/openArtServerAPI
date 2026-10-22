process.env.NODE_ENV = "test";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WorkflowAuthorizationService } from "../../src/platform/workflow/WorkflowAuthorizationService.js";

/**
 * Chainable fake of the Supabase query builder, per table:
 *   client().from("workflow").select(...).in("id", ids)  → awaited result
 *   client().from("media").select(...).eq(...).maybeSingle() → awaited result
 */
function fakeDb({ workflowRows, workflowError, mediaRow, mediaError, wfAsMediaRow, wfAsMediaError }) {
    const build = () => {
        const builder = {};
        const finishArr = () => ({ data: workflowRows || [], error: workflowError || null });
        builder.select = () => builder;
        builder.eq = () => builder;
        builder.in = async () => finishArr();
        builder.maybeSingle = () => {};
        builder.maybeSingle = async () => ({ data: mediaRow ?? wfAsMediaRow ?? null, error: (mediaError || wfAsMediaError) || null });
        return builder;
    };
    return {
        media: { client: () => ({ from: () => build() }) },
        workflows: { client: () => ({ from: () => build() }) },
    };
}

function makeService(tables) {
    return new WorkflowAuthorizationService({ db: tables });
}

describe("WorkflowAuthorizationService — fail-closed ownership", () => {
    let origBypass;
    beforeEach(() => {
        origBypass = process.env.DEV_AUTH_BYPASS;
        delete process.env.DEV_AUTH_BYPASS;
    });
    afterEach(() => {
        if (origBypass !== undefined) process.env.DEV_AUTH_BYPASS = origBypass;
    });

    describe("verifyWorkflowOwnershipBulk", () => {
        it("authorizes records owned by the requesting user", async () => {
            const service = makeService(fakeDb({
                workflowRows: [
                    { id: "wf-1", project: { user_id: "user-A" } },
                    { id: "wf-2", project: { user_id: "user-A" } },
                ],
            }));
            const owned = await service.verifyWorkflowOwnershipBulk(["wf-1", "wf-2"], "user-A");
            assert.deepEqual(owned, ["wf-1", "wf-2"]);
        });

        it("rejects everything when one record is owned by another user", async () => {
            const service = makeService(fakeDb({
                workflowRows: [
                    { id: "wf-1", project: { user_id: "user-A" } },
                    { id: "wf-2", project: { user_id: "user-B" } },
                ],
            }));
            assert.equal(await service.verifyWorkflowOwnershipBulk(["wf-1", "wf-2"], "user-A"), null);
        });

        it("rejects records whose project has no owner (NULL user_id)", async () => {
            const service = makeService(fakeDb({
                workflowRows: [{ id: "wf-1", project: { user_id: null } }],
            }));
            const owned = await service.verifyWorkflowOwnershipBulk(["wf-1"], "user-A");
            assert.equal(owned === null || owned?.length === 0, true, "null-owner workflows must not authorize any user");
        });

        it("rejects records missing from the database", async () => {
            const service = makeService(fakeDb({ workflowRows: [] }));
            assert.equal(await service.verifyWorkflowOwnershipBulk(["wf-ghost"], "user-A"), null);
        });

        it("propagates database errors instead of turning them into authorization results", async () => {
            const service = makeService(fakeDb({ workflowRows: [], workflowError: new Error("connection reset") }));
            await assert.rejects(
                async () => service.verifyWorkflowOwnershipBulk(["wf-1"], "user-A"),
                /connection reset/
            );
        });
    });

    describe("verifyMediaOwnership", () => {
        it("authorizes media owned by the requesting user", async () => {
            const service = makeService(fakeDb({ mediaRow: { id: "m-1", project: { user_id: "user-A" } } }));
            assert.equal(await service.verifyMediaOwnership("m-1", "user-A"), true);
        });

        it("rejects media owned by another user", async () => {
            const service = makeService(fakeDb({ mediaRow: { id: "m-1", project: { user_id: "user-B" } } }));
            assert.equal(await service.verifyMediaOwnership("m-1", "user-A"), false);
        });

        it("rejects media whose project has no owner (NULL user_id)", async () => {
            const service = makeService(fakeDb({ mediaRow: { id: "m-1", project: { user_id: null } } }));
            assert.equal(await service.verifyMediaOwnership("m-1", "user-A"), false);
        });

        it("rejects media and owner-workflow lookups that resolve to nothing", async () => {
            const service = makeService(fakeDb({})); // no media row, no workflow row
            assert.equal(await service.verifyMediaOwnership("m-ghost", "user-A"), false);
        });

        it("still authorizes a media_id that resolves to the user's own workflow", async () => {
            const service = makeService(fakeDb({ wfAsMediaRow: { id: "wf-1", project: { user_id: "user-A" } } }));
            assert.equal(await service.verifyMediaOwnership("wf-1", "user-A"), true);
        });

        it("rejects a media_id that resolves to a foreign workflow", async () => {
            const service = makeService(fakeDb({ wfAsMediaRow: { id: "wf-1", project: { user_id: "user-B" } } }));
            assert.equal(await service.verifyMediaOwnership("wf-1", "user-A"), false);
        });

        it("propagates database errors instead of authorizing by default", async () => {
            const service = makeService(fakeDb({ mediaError: new Error("timeout reading media") }));
            await assert.rejects(
                async () => service.verifyMediaOwnership("m-1", "user-A"),
                /timeout reading media/
            );
        });
    });
});
