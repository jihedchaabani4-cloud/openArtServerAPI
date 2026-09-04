import { v4 as uuidv4 } from "uuid";
import { InsufficientCreditsError, ReservationExpiredError } from "../models/errors/index.js";

/**
 * Lightweight in-memory implementation of the Two-Phase Wallet Protocol.
 * Used for testing and local execution of the reservation lifecycle.
 */
class InMemoryWalletService {
  constructor() {
    this.balances = new Map(); // userId -> number
    this.reservations = new Map(); // reservationId -> ReservationRecord
    this.HOLD_TTL_MS = 10 * 60 * 1000; // 10 minutes
  }

  async setBalance(userId, amount) {
    this.balances.set(userId, Math.max(0, amount));
    return this.balances.get(userId);
  }

  async getBalance(userId) {
    return this.balances.get(userId) || 0;
  }

  async reserve({ userId, amount, model, operation, pricingVersion, referenceId }) {
    const currentBalance = await this.getBalance(userId);
    if (currentBalance < amount) {
      throw new InsufficientCreditsError(amount, currentBalance);
    }

    const reservationId = referenceId || `res_${uuidv4()}`;
    const now = Date.now();
    const reservation = {
      reservationId,
      userId,
      amount,
      model,
      operation,
      pricingVersion,
      status: "held",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.HOLD_TTL_MS).toISOString(),
      expiresAtMs: now + this.HOLD_TTL_MS
    };

    this.balances.set(userId, currentBalance - amount);
    this.reservations.set(reservationId, reservation);

    return reservation;
  }

  async commit(reservationId, metadata = {}) {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      throw new ReservationExpiredError(reservationId);
    }
    if (reservation.status !== "held") {
      throw new Error(`Cannot commit reservation in status "${reservation.status}"`);
    }

    reservation.status = "committed";
    reservation.committedAt = new Date().toISOString();
    reservation.metadata = metadata;
    return reservation;
  }

  async release(reservationId, metadata = {}) {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      throw new ReservationExpiredError(reservationId);
    }
    if (reservation.status !== "held") {
      return reservation; // Already finalized
    }

    reservation.status = "released";
    reservation.releasedAt = new Date().toISOString();
    reservation.releaseReason = metadata.reason || "operation_failed";

    // Restore user balance
    const currentBalance = await this.getBalance(reservation.userId);
    this.balances.set(reservation.userId, currentBalance + reservation.amount);

    return reservation;
  }

  async reapExpiredHolds() {
    const now = Date.now();
    let reapedCount = 0;
    for (const [id, res] of this.reservations) {
      if (res.status === "held" && res.expiresAtMs <= now) {
        await this.release(id, { reason: "ttl_expired" });
        reapedCount++;
      }
    }
    return reapedCount;
  }
}

export const walletService = new InMemoryWalletService();
export { InMemoryWalletService };
