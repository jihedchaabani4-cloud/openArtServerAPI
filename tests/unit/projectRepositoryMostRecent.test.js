process.env.NODE_ENV = "test";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProjectRepository } from "../../src/db/ProjectRepository.js";

/**
 * Minimal fake of the Supabase query builder at the repository's client()
 * seam. Records the shape of the query (ordering/limit) and resolves the
 * terminal call with the configured result.
 */
function makeRepo({ result, error, onOrder } = {}) {
    const repo = new ProjectRepository();
    const builder = {};
    builder.select = () => builder;
    builder.eq = () => builder;
    builder.order = (column, opts) => {
        if (onOrder) onOrder(column, opts);
        return builder;
    };
    builder.limit = () => builder;
    builder.maybeSingle = async () => ({ data: result ?? null, error: error || null });
    repo.client = () => ({ from: () => builder });
    return repo;
}

describe("ProjectRepository.findMostRecentForUser", () => {
    it("queries the most recent project explicitly by create_time descending", async () => {
        let recorded;
        const repo = makeRepo({
            result: { id: "p-latest-2", user_id: "u1" },
            onOrder: (column, opts) => {
                recorded = { column, opts };
            },
        });

        const project = await repo.findMostRecentForUser("u1");

        assert.equal(project.id, "p-latest-2");
        assert.deepEqual(recorded, { column: "create_time", opts: { ascending: false } });
    });

    it("returns null when the user has no projects", async () => {
        const repo = makeRepo({ result: null });
        assert.equal(await repo.findMostRecentForUser("u1"), null);
    });

    it("propagates repository errors to the caller", async () => {
        const repo = makeRepo({ error: new Error("supabase unavailable") });
        await assert.rejects(
            async () => repo.findMostRecentForUser("u1"),
            /supabase unavailable/
        );
    });
});
