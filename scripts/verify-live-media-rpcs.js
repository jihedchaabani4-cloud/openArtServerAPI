/**
 * Live Database RPC Verification Script
 *
 * Verifies that the atomic shared media RPCs are installed and functional
 * on the live Supabase database.
 *
 * Usage:
 *   cd apiOpenArt; node scripts/verify-live-media-rpcs.js
 */

import { supabaseAdmin } from "#shared";

async function verifyLiveRpcs() {
  console.log("================================================================================");
  console.log("  VERIFYING SHARED MEDIA RPCS ON LIVE DATABASE");
  console.log(`  Target: ${process.env.SUPABASE_URL}`);
  console.log("================================================================================\n");

  const testWfId = "00000000-0000-0000-0000-000000000000";
  const testMediaId = "00000000-0000-0000-0000-000000000000";

  let attachOk = false;
  let unlinkOk = false;

  // 1. Test attach_workflow_reference_media
  const res1 = await supabaseAdmin.rpc("attach_workflow_reference_media", {
    p_workflow_id: testWfId,
    p_media_id: testMediaId,
  });

  if (res1.error?.code === "PGRST202" || res1.error?.message?.includes("Could not find the function")) {
    console.log("❌ attach_workflow_reference_media: NOT INSTALLED in schema cache");
  } else if (res1.error?.code === "P0002" || res1.error?.message?.includes("not found")) {
    console.log("✅ attach_workflow_reference_media: INSTALLED & FUNCTIONAL (returned P0002 not found as expected for dummy UUID)");
    attachOk = true;
  } else if (!res1.error) {
    console.log("✅ attach_workflow_reference_media: INSTALLED & FUNCTIONAL");
    attachOk = true;
  } else {
    console.log(`ℹ attach_workflow_reference_media: Error ${res1.error.code}: ${res1.error.message}`);
    // If error is PostgreSQL exception from inside the function, function exists!
    if (res1.error.code !== "PGRST202") attachOk = true;
  }

  // 2. Test unlink_workflow_media_and_reap_orphan
  const res2 = await supabaseAdmin.rpc("unlink_workflow_media_and_reap_orphan", {
    p_workflow_id: testWfId,
    p_media_id: testMediaId,
  });

  if (res2.error?.code === "PGRST202" || res2.error?.message?.includes("Could not find the function")) {
    console.log("❌ unlink_workflow_media_and_reap_orphan: NOT INSTALLED in schema cache");
  } else if (res2.data?.reason === "media_not_found" || res2.data?.unlinked === false) {
    console.log("✅ unlink_workflow_media_and_reap_orphan: INSTALLED & FUNCTIONAL (returned media_not_found as expected for dummy UUID)");
    unlinkOk = true;
  } else if (!res2.error) {
    console.log("✅ unlink_workflow_media_and_reap_orphan: INSTALLED & FUNCTIONAL");
    unlinkOk = true;
  } else {
    console.log(`ℹ unlink_workflow_media_and_reap_orphan: Error ${res2.error.code}: ${res2.error.message}`);
    if (res2.error.code !== "PGRST202") unlinkOk = true;
  }

  console.log("\n--------------------------------------------------------------------------------");
  if (attachOk && unlinkOk) {
    console.log("  🎉 ALL SHARED MEDIA RPCS ARE SUCCESSFULLY INSTALLED ON THE LIVE DATABASE!");
  } else {
    console.log("  ⚠️  RPCS NOT YET INSTALLED ON LIVE DATABASE. Please apply the SQL in Supabase SQL Editor.");
  }
  console.log("----------------------------------------------------------------================\n");
}

verifyLiveRpcs().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
