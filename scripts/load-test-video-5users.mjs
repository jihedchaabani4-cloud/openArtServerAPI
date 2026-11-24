#!/usr/bin/env node
/**
 * 5-User Concurrent Video Generation Load Test (3-Minute Wave Stress Test)
 *
 * - Creates 5 fresh confirmed Supabase users + funds each wallet with 1,000 credits via credit_wallet RPC
 * - Each user creates 1 project via real HTTP POST /api/projects
 * - Runs 6 waves over 3 minutes (t = 0s, 30s, 60s, 90s, 120s, 150s):
 *     Each wave fires 25 concurrent POST /api/video/generated requests (5 per user x 5 users)
 *     against live http://localhost:5000 using ltx_2_3_fast (6s, 720p, 16:9).
 * - Waits through the full 3-minute window + polls DB until in-flight jobs settle (or timeout)
 * - Verifies per-user isolation, media statuses, and wallet ledger reconciliation
 * - Leaves all 5 users + projects + media intact in Supabase and writes manifest for cleanup
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const API_BASE = process.env.LOAD_TEST_API_BASE || "http://localhost:5000";
const USER_COUNT = 5;
const REQUESTS_PER_USER_PER_WAVE = 5;
const WAVE_INTERVAL_MS = 30_000;
const TOTAL_TEST_DURATION_MS = 180_000; // 3 minutes
const TOTAL_WAVES = Math.floor(TOTAL_TEST_DURATION_MS / WAVE_INTERVAL_MS); // 6 waves: 0s, 30s, 60s, 90s, 120s, 150s
const INITIAL_CREDITS_PER_USER = 1000;
const SETTLE_POLL_TIMEOUT_MS = 180_000; // wait up to 3 extra mins for LTX videos to finish
const SETTLE_POLL_INTERVAL_MS = 10_000;

const MANIFEST_PATH =
  process.env.LOAD_TEST_MANIFEST_PATH ||
  path.resolve(process.cwd(), "scripts", ".load-test-video-last-run.json");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey || supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

const PROMPTS = [
  "Golden hour drone glide over misty turquoise coastal cliffs, slow cinematic motion, natural light",
  "Close-up of raindrops hitting a glowing neon city window at night, shallow depth of field, calm mood",
  "A lone sailboat drifting smoothly across mirror-still mountain lake water at sunrise, crisp 720p",
  "Slow dolly shot through a sunlit Japanese bamboo forest swaying gently in morning breeze",
  "Warm steam rising from an espresso cup on a wooden cafe table by a sunny window, subtle camera pan",
  "Time-lapse clouds flowing over snow-dusted alpine peaks under warm pastel dawn light",
  "Soft ocean waves rolling onto black volcanic sand beach in Iceland, steady aerial tracking shot",
  "Golden autumn leaves slowly falling along a quiet cobblestone lane in soft afternoon sunlight",
  "Glowing paper lanterns floating upward into a calm twilight sky over a tranquil river",
  "Sunlight beams filtering through an ancient redwood forest with gentle floating dust motes",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function checkServerHealth() {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) throw new Error(`API /health returned ${res.status}`);
  const ready = await fetch(`${API_BASE}/ready`);
  const readyJson = await ready.json().catch(() => ({}));
  if (!ready.ok || readyJson.ready !== true) {
    throw new Error(`API /ready not ready: status=${ready.status} body=${JSON.stringify(readyJson)}`);
  }
}

async function ensureAndFundWallet(userId, amount, runTag) {
  let wallet = null;
  const { data: existing } = await supabaseAdmin
    .from("wallets")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing) {
    const { data: updated, error: updErr } = await supabaseAdmin
      .from("wallets")
      .update({ balance: Number(existing.balance || 0) + amount })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (updErr) throw new Error(`Failed updating wallet for ${userId}: ${updErr.message}`);
    wallet = updated;
  } else {
    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from("wallets")
      .insert({ user_id: userId, balance: amount })
      .select("*")
      .single();
    if (insertErr) throw new Error(`Failed to create wallet for ${userId}: ${insertErr.message}`);
    wallet = inserted;
  }

  // Record matching CREDIT ledger transaction (supplying expires_at for NOT NULL constraint)
  const refId = `loadtest-fund:${runTag}:${userId}`;
  const { error: txErr } = await supabaseAdmin.from("transactions").insert({
    wallet_id: wallet.id,
    amount,
    type: "CREDIT",
    status: "COMPLETED",
    reference_id: refId,
    metadata: { source: "video_load_test", runTag },
    expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (txErr) {
    console.warn(`[WARN] Could not insert CREDIT ledger row for ${userId}: ${txErr.message}`);
  }

  return wallet;
}

async function provisionUsers(runTag) {
  const users = [];
  for (let i = 1; i <= USER_COUNT; i++) {
    const email = `loadtest.${runTag}.u${i}@labveil.test`;
    const password = `LoadTest!${runTag.slice(-6)}#${i}Aa`;

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { load_test_run: runTag, label: `LoadTest User ${i}` },
    });
    if (createErr || !created?.user?.id) {
      throw new Error(`Failed to create user ${email}: ${createErr?.message}`);
    }
    const userId = created.user.id;

    // Sign in to obtain a genuine Supabase access JWT
    const { data: signInData, error: signInErr } = await supabaseAuth.auth.signInWithPassword({
      email,
      password,
    });
    if (signInErr || !signInData?.session?.access_token) {
      throw new Error(`Failed to sign in ${email}: ${signInErr?.message}`);
    }
    const accessToken = signInData.session.access_token;

    // Fund wallet via atomic ledger RPC
    const wallet = await ensureAndFundWallet(userId, INITIAL_CREDITS_PER_USER, runTag);

    // Create 1 project via real HTTP POST /api/projects
    const projRes = await fetch(`${API_BASE}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ name: `Video LoadTest ${runTag} - User ${i}` }),
    });
    const projBody = await projRes.json().catch(() => ({}));
    if (!projRes.ok || !projBody?.data?.id) {
      throw new Error(`POST /api/projects failed for user ${i}: status=${projRes.status} body=${JSON.stringify(projBody)}`);
    }

    users.push({
      index: i,
      userId,
      email,
      password,
      accessToken,
      walletId: wallet.id,
      initialBalance: Number(wallet.balance),
      projectId: projBody.data.id,
      projectName: projBody.data.name || `Video LoadTest ${runTag} - User ${i}`,
    });

    console.log(
      `[SETUP] User ${i}/${USER_COUNT} ready | id=${userId} | email=${email} | project=${projBody.data.id} | balance=${wallet.balance}`
    );
  }
  return users;
}

async function fireSingleVideoRequest(user, waveNumber, reqIndexInUser) {
  const promptBase = PROMPTS[(waveNumber * 7 + user.index * 3 + reqIndexInUser) % PROMPTS.length];
  const prompt = `${promptBase} (w${waveNumber}-u${user.index}-r${reqIndexInUser})`;
  const startedAt = Date.now();

  try {
    const res = await fetch(`${API_BASE}/api/video/generated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${user.accessToken}`,
      },
      body: JSON.stringify({
        prompt,
        model: "ltx_2_3_fast",
        project_id: user.projectId,
        parameters: {
          duration: 6,
          aspect_ratio: "16:9",
          resolution: "720p",
          fps: 24,
          generate_audio: false,
        },
      }),
    });

    const latencyMs = Date.now() - startedAt;
    const body = await res.json().catch(() => ({}));
    return {
      wave: waveNumber,
      userIndex: user.index,
      userId: user.userId,
      projectId: user.projectId,
      reqIndexInUser,
      httpStatus: res.status,
      latencyMs,
      ok: res.ok && body?.ok === true,
      status: body?.status || null,
      needsCredits: Boolean(body?.needsCredits),
      cost: body?.cost ?? null,
      workflowId: body?.workflowId || null,
      mediaId: body?.mediaId || null,
      taskId: body?.taskId || null,
      errorCode: body?.code || body?.errorCode || null,
      message: body?.message || null,
      retryAfter: res.headers.get("retry-after") || null,
    };
  } catch (err) {
    return {
      wave: waveNumber,
      userIndex: user.index,
      userId: user.userId,
      projectId: user.projectId,
      reqIndexInUser,
      httpStatus: 0,
      latencyMs: Date.now() - startedAt,
      ok: false,
      status: "network_error",
      needsCredits: false,
      cost: null,
      workflowId: null,
      mediaId: null,
      taskId: null,
      errorCode: "NETWORK_ERROR",
      message: err?.message || String(err),
      retryAfter: null,
    };
  }
}

function summarizeStatuses(records) {
  const counts = {};
  for (const r of records) {
    const key = String(r.httpStatus);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function pollMediaCompletion(mediaIds) {
  if (!mediaIds.length) return [];
  const pollStart = Date.now();
  let latestRows = [];

  while (true) {
    const { data, error } = await supabaseAdmin
      .from("media")
      .select("id, project_id, status, url, error_message, create_time")
      .in("id", mediaIds);

    if (error) {
      console.error(`[POLL] Error querying media: ${error.message}`);
    } else {
      latestRows = data || [];
      const counts = { processing: 0, success: 0, failed: 0, other: 0 };
      for (const row of latestRows) {
        if (row.status === "processing") counts.processing++;
        else if (row.status === "success") counts.success++;
        else if (row.status === "failed") counts.failed++;
        else counts.other++;
      }
      const elapsedS = ((Date.now() - pollStart) / 1000).toFixed(0);
      console.log(
        `[SETTLE +${elapsedS}s] tracked=${latestRows.length}/${mediaIds.length} | success=${counts.success} | failed=${counts.failed} | processing=${counts.processing}`
      );
      if (counts.processing === 0) break;
    }

    if (Date.now() - pollStart >= SETTLE_POLL_TIMEOUT_MS) {
      console.warn(`[SETTLE] Timeout reached (${SETTLE_POLL_TIMEOUT_MS / 1000}s) with some media still processing.`);
      break;
    }
    await sleep(SETTLE_POLL_INTERVAL_MS);
  }

  return latestRows;
}

async function inspectWalletsAndIsolation(users, acceptedRecords, mediaRows) {
  const mediaById = new Map(mediaRows.map((m) => [m.id, m]));
  const perUser = [];
  let crossUserLeaks = 0;

  for (const user of users) {
    const userAccepted = acceptedRecords.filter((r) => r.userId === user.userId);
    let successCount = 0;
    let failedCount = 0;
    let processingCount = 0;
    const errorBuckets = {};

    for (const rec of userAccepted) {
      const row = mediaById.get(rec.mediaId);
      if (!row) continue;
      if (row.project_id !== user.projectId) {
        crossUserLeaks++;
      }
      if (row.status === "success") successCount++;
      else if (row.status === "failed") {
        failedCount++;
        const msg = (row.error_message || "unknown").slice(0, 120);
        errorBuckets[msg] = (errorBuckets[msg] || 0) + 1;
      } else {
        processingCount++;
      }
    }

    const { data: walletRow } = await supabaseAdmin
      .from("wallets")
      .select("*")
      .eq("id", user.walletId)
      .single();

    const { data: txRows } = await supabaseAdmin
      .from("transactions")
      .select("type, amount, status, reference_id")
      .eq("wallet_id", user.walletId);

    const txSummary = { CREDIT: 0, HOLD_PENDING: 0, HOLD_COMPLETED: 0, HOLD_ROLLED_BACK: 0, OTHER: 0 };
    let completedHoldSum = 0;
    let pendingHoldSum = 0;

    for (const tx of txRows || []) {
      const amt = Number(tx.amount || 0);
      if (tx.type === "CREDIT" && tx.status === "COMPLETED") txSummary.CREDIT += 1;
      else if (tx.status === "PENDING") {
        txSummary.HOLD_PENDING += 1;
        pendingHoldSum += amt;
      } else if (tx.status === "COMPLETED") {
        txSummary.HOLD_COMPLETED += 1;
        completedHoldSum += amt;
      } else if (tx.status === "ROLLED_BACK" || tx.status === "CANCELLED" || tx.status === "EXPIRED" || tx.status === "FAILED") {
        txSummary.HOLD_ROLLED_BACK += 1;
      } else {
        txSummary.OTHER += 1;
      }
    }

    const finalBalance = Number(walletRow?.balance ?? -1);
    const netDeducted = user.initialBalance - finalBalance;
    const expectedDeducted = completedHoldSum + pendingHoldSum;

    perUser.push({
      userIndex: user.index,
      userId: user.userId,
      email: user.email,
      projectId: user.projectId,
      acceptedJobs: userAccepted.length,
      successCount,
      failedCount,
      processingCount,
      initialBalance: user.initialBalance,
      finalBalance,
      netDeducted,
      completedHoldSum,
      pendingHoldSum,
      balanceMatchesLedger: Math.abs(netDeducted - expectedDeducted) < 0.01,
      txSummary,
      errorBuckets,
    });
  }

  return { perUser, crossUserLeaks };
}

async function main() {
  const runTag = `lt${Date.now().toString(36)}`;
  console.log(`\n======================================================================`);
  console.log(` 5-USER LIVE VIDEO LOAD TEST (ltx_2_3_fast, 6s, 25 req/30s, 3 minutes)`);
  console.log(` RunTag: ${runTag} | API: ${API_BASE}`);
  console.log(`======================================================================\n`);

  await checkServerHealth();
  console.log("[HEALTH] API /health and /ready OK");

  const users = await provisionUsers(runTag);

  // Persist manifest IMMEDIATELY (without JWTs or passwords) so cleanup works even if interrupted
  const manifestBase = {
    runTag,
    createdAt: new Date().toISOString(),
    apiBase: API_BASE,
    model: "ltx_2_3_fast",
    users: users.map(({ accessToken: _omitTok, password: _omitPwd, ...safe }) => safe),
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifestBase, null, 2));
  console.log(`[MANIFEST] Saved user/project manifest to ${MANIFEST_PATH}\n`);

  const testStartMs = Date.now();
  const allRecords = [];
  const waveSummaries = [];

  for (let wave = 1; wave <= TOTAL_WAVES; wave++) {
    const targetOffsetMs = (wave - 1) * WAVE_INTERVAL_MS;
    const waitMs = testStartMs + targetOffsetMs - Date.now();
    if (waitMs > 0) {
      console.log(`[WAIT] Sleeping ${(waitMs / 1000).toFixed(1)}s before Wave ${wave}/${TOTAL_WAVES}...`);
      await sleep(waitMs);
    }

    const elapsedS = ((Date.now() - testStartMs) / 1000).toFixed(1);
    console.log(`\n[WAVE ${wave}/${TOTAL_WAVES} @ t=+${elapsedS}s] Firing ${USER_COUNT * REQUESTS_PER_USER_PER_WAVE} concurrent POST /api/video/generated requests...`);

    const promises = [];
    for (const user of users) {
      for (let r = 1; r <= REQUESTS_PER_USER_PER_WAVE; r++) {
        promises.push(fireSingleVideoRequest(user, wave, r));
      }
    }

    const waveStart = Date.now();
    const results = await Promise.all(promises);
    const waveDurationMs = Date.now() - waveStart;

    allRecords.push(...results);
    const statusCounts = summarizeStatuses(results);
    const acceptedInWave = results.filter((r) => r.httpStatus === 200 && r.status === "processing").length;
    const rateLimitedInWave = results.filter((r) => r.httpStatus === 429).length;
    const latencies = results.map((r) => r.latencyMs);

    const summary = {
      wave,
      elapsedS: Number(elapsedS),
      waveDurationMs,
      statusCounts,
      acceptedInWave,
      rateLimitedInWave,
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      maxMs: Math.max(...latencies),
    };
    waveSummaries.push(summary);

    console.log(
      `[WAVE ${wave} DONE in ${waveDurationMs}ms] statuses=${JSON.stringify(statusCounts)} | accepted=${acceptedInWave} | 429=${rateLimitedInWave} | p50=${summary.p50Ms}ms p95=${summary.p95Ms}ms max=${summary.maxMs}ms`
    );

    // Log any unexpected error samples (non-200 and non-429)
    const unexpected = results.filter((r) => r.httpStatus !== 200 && r.httpStatus !== 429);
    if (unexpected.length > 0) {
      console.warn(
        `[WAVE ${wave} UNEXPECTED ERRORS (${unexpected.length})]:`,
        unexpected.slice(0, 5).map((u) => ({ user: u.userIndex, status: u.httpStatus, code: u.errorCode, msg: u.message }))
      );
    }
  }

  // Complete the full 3-minute (180s) observation window
  const remainingWindowMs = testStartMs + TOTAL_TEST_DURATION_MS - Date.now();
  if (remainingWindowMs > 0) {
    console.log(`\n[WINDOW] Waiting remaining ${(remainingWindowMs / 1000).toFixed(1)}s to finish full 3-minute load window...`);
    await sleep(remainingWindowMs);
  }

  const acceptedRecords = allRecords.filter((r) => r.httpStatus === 200 && r.mediaId && r.status === "processing");
  const mediaIds = [...new Set(acceptedRecords.map((r) => r.mediaId))];

  console.log(`\n[3-MINUTE WINDOW COMPLETE] Total HTTP attempts=${allRecords.length} | Accepted jobs=${acceptedRecords.length} | Polling DB until jobs settle...`);
  const mediaRows = await pollMediaCompletion(mediaIds);

  const { perUser, crossUserLeaks } = await inspectWalletsAndIsolation(users, acceptedRecords, mediaRows);

  const totalSuccess = mediaRows.filter((m) => m.status === "success").length;
  const totalFailed = mediaRows.filter((m) => m.status === "failed").length;
  const totalProcessing = mediaRows.filter((m) => m.status === "processing").length;
  const allLatencies = allRecords.map((r) => r.latencyMs);
  const okLatencies = acceptedRecords.map((r) => r.latencyMs);

  const report = {
    ...manifestBase,
    finishedAt: new Date().toISOString(),
    totals: {
      httpAttempts: allRecords.length,
      httpStatusCounts: summarizeStatuses(allRecords),
      acceptedJobs: acceptedRecords.length,
      rateLimited429: allRecords.filter((r) => r.httpStatus === 429).length,
      otherErrors: allRecords.filter((r) => r.httpStatus !== 200 && r.httpStatus !== 429).length,
      mediaSuccess: totalSuccess,
      mediaFailed: totalFailed,
      mediaStillProcessing: totalProcessing,
      crossUserLeaks,
      allLatencyMs: { p50: percentile(allLatencies, 50), p95: percentile(allLatencies, 95), max: Math.max(0, ...allLatencies) },
      acceptedLatencyMs: { p50: percentile(okLatencies, 50), p95: percentile(okLatencies, 95), max: Math.max(0, ...okLatencies) },
    },
    waves: waveSummaries,
    perUser,
    sampleSucceededUrls: mediaRows.filter((m) => m.status === "success" && m.url).slice(0, 5).map((m) => ({ id: m.id, projectId: m.project_id, url: m.url })),
    sampleErrors: mediaRows.filter((m) => m.status === "failed").slice(0, 10).map((m) => ({ id: m.id, error: m.error_message })),
  };

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(report, null, 2));

  console.log(`\n====================== FINAL LOAD TEST REPORT ======================`);
  console.log(JSON.stringify(report.totals, null, 2));
  console.log(`\nPer-user reconciliation:`);
  for (const u of perUser) {
    console.log(
      `  User ${u.userIndex} (${u.email}): accepted=${u.acceptedJobs} | success=${u.successCount} | failed=${u.failedCount} | proc=${u.processingCount} | balance=${u.initialBalance}->${u.finalBalance} (spent=${u.netDeducted}, completedHolds=${u.completedHoldSum}, pendingHolds=${u.pendingHoldSum}, ledgerMatch=${u.balanceMatchesLedger})`
    );
  }
  console.log(`\nFull report & user IDs saved to: ${MANIFEST_PATH}`);
  console.log(`Cleanup command (whenever ready): node scripts/cleanup-load-test-users.mjs`);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
