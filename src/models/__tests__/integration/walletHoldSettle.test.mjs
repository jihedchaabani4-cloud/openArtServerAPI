import test from "node:test";
import assert from "node:assert/strict";
import { walletService } from "../../../services/walletService.js";
import { InsufficientCreditsError } from "../../errors/index.js";

test("Wallet Two-Phase Commit Lifecycle: Hold, Settle & Release", async (t) => {
  const userId = "test_usr_42";
  await walletService.setBalance(userId, 50);

  await t.test("Reserve locks credits and creates hold record", async () => {
    const hold = await walletService.reserve({
      userId,
      amount: 20,
      model: "nanobana_pro",
      operation: "text_to_image",
      pricingVersion: "2026-09-v1"
    });

    assert.equal(hold.status, "held");
    assert.equal(hold.amount, 20);

    const available = await walletService.getBalance(userId);
    assert.equal(available, 30, "Available balance reduced by 20");
  });

  await t.test("Throws InsufficientCreditsError when requesting more than available balance", async () => {
    // Current available is 30; requesting 35 must fail
    await assert.rejects(
      async () => {
        await walletService.reserve({
          userId,
          amount: 35,
          model: "nanobana_pro",
          operation: "text_to_image",
          pricingVersion: "2026-09-v1"
        });
      },
      InsufficientCreditsError
    );
  });

  await t.test("Release restores held credits upon failure", async () => {
    const hold = await walletService.reserve({
      userId,
      amount: 15,
      model: "nanobana_pro",
      operation: "text_to_image",
      pricingVersion: "2026-09-v1"
    });

    assert.equal(await walletService.getBalance(userId), 15); // 30 - 15 = 15

    await walletService.release(hold.reservationId, { reason: "provider_500_error" });

    assert.equal(await walletService.getBalance(userId), 30, "Credits restored after release");
  });

  await t.test("Reaping expired holds restores abandoned reservations", async () => {
    const hold = await walletService.reserve({
      userId,
      amount: 10,
      model: "nanobana_pro",
      operation: "text_to_image",
      pricingVersion: "2026-09-v1"
    });

    // Manually force expiration
    hold.expiresAtMs = Date.now() - 1000;

    const reaped = await walletService.reapExpiredHolds();
    assert.equal(reaped, 1);
    assert.equal(await walletService.getBalance(userId), 30, "Reaper restored expired reservation");
  });
});
