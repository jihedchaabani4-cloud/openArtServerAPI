import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const userId = "932d4215-9cae-4abf-9def-6b82644aa459";

const supabase = createClient(supabaseUrl, supabaseKey);

async function ensureWalletAndCredit() {
  // Check if wallet exists
  const { data: existing, error: findErr } = await supabase
    .from("wallets")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (findErr) {
    console.error("Find wallet error:", findErr);
    process.exit(1);
  }

  let walletId;
  if (!existing) {
    console.log("Wallet not found, creating...");
    const { data: created, error: createErr } = await supabase
      .from("wallets")
      .insert({ user_id: userId, balance: 100 })
      .select("*")
      .single();
    if (createErr) {
      console.error("Create wallet error:", createErr);
      process.exit(1);
    }
    walletId = created.id;
    console.log("Created wallet:", walletId, "balance:", created.balance);
  } else {
    walletId = existing.id;
    console.log("Found wallet:", walletId, "balance:", existing.balance);
    if (existing.balance < 10) {
      const { data: updated, error: updateErr } = await supabase
        .from("wallets")
        .update({ balance: 100 })
        .eq("id", walletId)
        .select("*")
        .single();
      if (updateErr) {
        console.error("Update wallet error:", updateErr);
        process.exit(1);
      }
      console.log("Updated balance to:", updated.balance);
    }
  }

  // Add a credit transaction for traceability
  const { error: txErr } = await supabase
    .from("transactions")
    .insert({
      wallet_id: walletId,
      amount: 100,
      type: "CREDIT",
      status: "COMPLETED",
      reference_id: `dev-credit-${Date.now()}`,
      metadata: { reason: "Dev test credit" },
    });

  if (txErr) {
    console.warn("Transaction insert error (non-fatal):", txErr);
  } else {
    console.log("Credit transaction recorded.");
  }

  console.log("Done! User has wallet with 100 credits.");
}

ensureWalletAndCredit().catch((e) => {
  console.error(e);
  process.exit(1);
});
