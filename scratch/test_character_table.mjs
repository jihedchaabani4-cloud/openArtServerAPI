import "dotenv/config";
import { supabase } from "../lib/supabase.js";

async function testCharacterTable() {
  console.log("\n🔍 Checking table 'character' in Supabase DB...");
  const { data: charData, error: charErr } = await supabase
    .from("character")
    .select("*")
    .limit(1);

  if (charErr) {
    console.warn("⚠️ 'character' table notice:", charErr.message);
  } else {
    console.log("✅ 'character' table exists! Data:", charData);
  }

  console.log("\n🔍 Checking table 'dna' in Supabase DB...");
  const { data: dnaData, error: dnaErr } = await supabase
    .from("dna")
    .select("*")
    .limit(1);

  if (dnaErr) {
    console.warn("⚠️ 'dna' table notice:", dnaErr.message);
  } else {
    console.log("✅ 'dna' table exists! Data:", dnaData);
  }
}

testCharacterTable().catch(console.error);
