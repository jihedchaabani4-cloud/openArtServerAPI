/**
 * Integration Test Script for Element Service V1 (Direct Save)
 * Run: node test_element_v1_service.js
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { supabase } from "./lib/supabase.js";
import * as elementService from "./src/services/elementService.js";
import promptBuilderProService from "./src/services/promptBuilderProService.js";



async function runTests() {
    console.log("=================================================");
    console.log("🧪 STARTING ELEMENT SERVICE V1 INTEGRATION TESTS");
    console.log("=================================================\n");

    // Create a real test project in DB using correct column names
    const testUserId    = randomUUID();
    const { data: testProject, error: pErr } = await supabase
        .from("project")
        .insert({ project_name: `Test Project ${randomUUID().slice(0, 4)}`, user_id: testUserId })
        .select()
        .single();

    if (pErr) throw pErr;
    const testProjectId = testProject.id;



    let createdElementId = null;

    let passed = 0;
    let failed = 0;

    function assert(condition, message) {
        if (condition) {
            console.log(`  ✅ PASS: ${message}`);
            passed++;
        } else {
            console.error(`  ❌ FAIL: ${message}`);
            failed++;
        }
    }

    // ─── TEST 1: Validation — Empty Name ──────────────────────────────────────
    console.log("📌 Test 1: Validation — Empty Name");
    try {
        await elementService.createElement({
            name: "",
            sourceImages: ["https://example.com/test.jpg"],
            projectId: testProjectId,
        });
        assert(false, "Should have thrown error for empty name");
    } catch (err) {
        assert(err.message.includes("Element name is required"), `Correctly rejected empty name (${err.message})`);
    }

    // ─── TEST 2: Validation — 0 Images ────────────────────────────────────────
    console.log("\n📌 Test 2: Validation — 0 Reference Images");
    try {
        await elementService.createElement({
            name: "Test Object",
            sourceImages: [],
            projectId: testProjectId,
        });
        assert(false, "Should have thrown error for 0 images");
    } catch (err) {
        assert(err.message.includes("At least 1 reference image is required"), `Correctly rejected 0 images (${err.message})`);
    }

    // ─── TEST 3: Validation — Too Many Images (> 6) ───────────────────────────
    console.log("\n📌 Test 3: Validation — > 6 Reference Images");
    try {
        await elementService.createElement({
            name: "Test Object",
            sourceImages: [1, 2, 3, 4, 5, 6, 7].map(i => `https://example.com/${i}.jpg`),
            projectId: testProjectId,
        });
        assert(false, "Should have thrown error for 7 images");
    } catch (err) {
        assert(err.message.includes("Maximum 6 reference images allowed"), `Correctly rejected > 6 images (${err.message})`);
    }

    // ─── TEST 4: Create Element (Valid — 2 Images + Description) ─────────────
    console.log("\n📌 Test 4: Create Element (Valid — 2 Images + Description)");
    try {
        const testName = `TestCamera_${randomUUID().slice(0, 4)}`;
        // Use 1x1 transparent PNG data URIs for offline storage test
        const img1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        const img2 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

        const result = await elementService.createElement({
            name: testName,
            sourceImages: [img1, img2],
            description: "Vintage 1960 camera with dark leather body.",
            projectId: testProjectId,
            userId: testUserId,
            tags: ["camera", "test"],
        });

        const element = result.element;
        const workflow = result.workflow;

        createdElementId = element.id;

        assert(Boolean(element.id), `Element created with ID: ${element.id}`);
        assert(element.name === testName, `Element name matches: ${element.name}`);
        assert(element.source_images_count === 2, `Image count matches: 2`);
        assert(Boolean(element.primary_media_url), `Primary media URL returned: ${element.primary_media_url?.slice(0, 40)}...`);
        assert(Boolean(workflow.id), `Workflow container created with ID: ${workflow.id}`);
        assert(workflow.workflow_type === "ELEMENT_SHEET", `Workflow type is ELEMENT_SHEET`);
        assert(workflow.items.length === 2, `Workflow items length matches: 2`);
        assert(Array.isArray(result.media) && result.media.length === 2, `Top-level media array returned with 2 items`);


    } catch (err) {
        assert(false, `Create element failed: ${err.message}`);
        console.error(err);
    }

    // ─── TEST 5: List Project Elements ────────────────────────────────────────
    if (createdElementId) {
        console.log("\n📌 Test 5: List Project Elements");
        try {
            const list = await elementService.listProjectElements(testProjectId);
            assert(Array.isArray(list), "Returns array of elements");
            assert(list.length === 1, `List contains 1 element for project ${testProjectId}`);
            assert(list[0].id === createdElementId, `Listed element ID matches created ID`);
            assert(Boolean(list[0].primary_media_url), "Listed element includes primary_media_url");
        } catch (err) {
            assert(false, `List elements failed: ${err.message}`);
        }
    }

    // ─── TEST 6: Get Element By ID ────────────────────────────────────────────
    if (createdElementId) {
        console.log("\n📌 Test 6: Get Element By ID");
        try {
            const detail = await elementService.getElementById(createdElementId);
            assert(Boolean(detail), "Element retrieved successfully");
            assert(detail.id === createdElementId, "Element ID matches");
            assert(Array.isArray(detail.reference_images), "reference_images is an array");
            assert(detail.reference_images.length === 2, `reference_images length is 2`);
        } catch (err) {
            assert(false, `Get element by ID failed: ${err.message}`);
        }
    }

    // ─── TEST 7: Resolve @ElementName Token in Prompt Builder ────────────────
    if (createdElementId) {
        console.log("\n📌 Test 7: Resolve @ElementName Token in Prompt Builder");
        try {
            const detail = await elementService.getElementById(createdElementId);
            const elementName = detail.name;

            const payload = await promptBuilderProService.buildMultiElementPayload({
                userPrompt: `@${elementName} placed on a sunlit wooden desk`,
                projectId: testProjectId,
            });

            assert(payload.scenePrompt === "placed on a sunlit wooden desk", `Token stripped from scenePrompt: "${payload.scenePrompt}"`);
            assert(payload.referenceImages.length === 2, `Reference images resolved: ${payload.referenceImages.length}`);
            assert(payload.contextNote.includes("Vintage 1960 camera"), `Context note included element description`);
        } catch (err) {
            assert(false, `@ElementName resolution failed: ${err.message}`);
        }
    }

    // ─── TEST 8: Delete Element ───────────────────────────────────────────────
    if (createdElementId) {
        console.log("\n📌 Test 8: Delete Element");
        try {
            const deleted = await elementService.deleteElement(createdElementId);
            assert(deleted === true, "deleteElement returned true");

            const listAfter = await elementService.listProjectElements(testProjectId);
            assert(listAfter.length === 0, `Element list is empty after deletion (${listAfter.length})`);
        } catch (err) {
            assert(false, `Delete element failed: ${err.message}`);
        }
    }

    // ─── SUMMARY ─────────────────────────────────────────────────────────────
    console.log("\n=================================================");
    console.log(`📊 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log("=================================================\n");

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error("Fatal Test Error:", err);
    process.exit(1);
});
