import { walletService as defaultWalletService } from "../../services/walletService.js";
import { createLogger, LogEvents } from "../../infrastructure/logging/index.js";

const logger = createLogger("models");

/**
 * Billing Bridge
 *
 * Encapsulates financial hold operations (reserve, commit, release),
 * keeping modelRunner decoupled from direct wallet management logic.
 */
export class BillingBridge {
  constructor(walletService = defaultWalletService) {
    this.walletService = walletService;
  }

  /**
   * Reserves a credit hold on the user's wallet unless noCharge or skipWalletHold is set.
   *
   * @param {object} params
   * @param {string} params.userId
   * @param {number} params.amount - Credits required (0 is no-op)
   * @param {string} params.modelId
   * @param {string} params.operation
   * @param {string} params.generationId
   * @param {boolean} [params.noCharge=false]
   * @param {boolean} [params.skipWalletHold=false]
   * @returns {Promise<object|null>} Reservation object or null
   */
  async reserveHold({ userId, amount, modelId, operation, generationId, noCharge, skipWalletHold }) {
    if (noCharge || skipWalletHold || !userId || !this.walletService || amount <= 0) {
      return null;
    }

    const reservation = await this.walletService.reserve({
      userId,
      amount,
      model: modelId,
      operation,
      pricingVersion: "fixed_retail",
      referenceId: `res_${generationId}`,
    });

    logger.info(
      { event: LogEvents.WALLET_HOLD_CREATED, userId, amount, generationId },
      `Held ${amount} credits for ${modelId} (${operation})`
    );

    return reservation;
  }

  /**
   * Commits the reserved credit hold upon successful execution and output validation.
   */
  async commitHold(reservation, { creditsCharged, generationId }) {
    if (!reservation || !this.walletService) return;

    await this.walletService.commit(reservation.reservationId, {
      creditsCharged,
      generationId,
    });
  }

  /**
   * Releases the reserved credit hold if execution fails or output contract is violated.
   */
  async releaseHold(reservation, { userId, creditsRequired, reason }) {
    if (!reservation || !this.walletService) return;

    await this.walletService.release(reservation.reservationId, {
      reason: reason || "Provider execution failed",
    });

    logger.info(
      { event: LogEvents.WALLET_HOLD_RELEASED, userId, reservationId: reservation.reservationId },
      `Released ${creditsRequired} credits due to execution error`
    );
  }
}

export const defaultBillingBridge = new BillingBridge();
