import { config } from "./config.js";
import * as policyClient from "./policy-client.js";
import type { BudgetInfo } from "./types.js";

/**
 * In-memory budget cache. Syncs from on-chain Soroban contract at startup
 * and after each spend. All amounts are BigInt (CLAUDE.md Rule 1).
 */
class BudgetTracker {
  private spentToday: bigint = 0n;
  private txCount = 0;
  private dailyLimit: bigint = config.defaultDailyLimit;
  private deniedCount = 0;
  private lastSyncDay: bigint = 0n;
  private synced = false;

  /**
   * Sync local state from on-chain contract.
   * Called at startup and on day rollover.
   */
  async syncFromSoroban(): Promise<void> {
    try {
      const stats = await policyClient.getLifetimeStats();
      this.spentToday = stats.spentToday;
      this.dailyLimit = stats.dailyLimit;
      this.txCount = stats.txCount;
      this.deniedCount = stats.deniedCount;
      this.lastSyncDay = BigInt(Math.floor(Date.now() / 1000 / 86400));
      this.synced = true;
    } catch {
      // If RPC is down at startup, use defaults. Will re-sync later.
      this.synced = false;
    }
  }

  /**
   * Fast in-memory check: is this amount within the remaining daily budget?
   * Does NOT call the chain — use checkPolicy for authoritative check.
   */
  checkLocal(amount: bigint): boolean {
    this.checkDayRollover();
    return this.spentToday + amount <= this.dailyLimit;
  }

  /**
   * Record a spend in the local cache. Called after confirmed on-chain record.
   */
  recordLocal(amount: bigint): void {
    this.checkDayRollover();
    this.spentToday += amount;
    this.txCount += 1;
  }

  /**
   * Get current budget snapshot.
   */
  getBudget(): BudgetInfo {
    this.checkDayRollover();
    return {
      spentToday: this.spentToday,
      remaining: this.dailyLimit - this.spentToday,
      dailyLimit: this.dailyLimit,
      txCount: this.txCount,
      deniedCount: this.deniedCount,
    };
  }

  /**
   * Whether initial sync from Soroban succeeded.
   */
  isSynced(): boolean {
    return this.synced;
  }

  /**
   * Reset on new UTC day (day_key = timestamp / 86400).
   */
  private checkDayRollover(): void {
    const currentDay = BigInt(Math.floor(Date.now() / 1000 / 86400));
    if (currentDay > this.lastSyncDay) {
      this.spentToday = 0n;
      this.lastSyncDay = currentDay;
    }
  }
}

/** Singleton budget tracker. */
export const budgetTracker = new BudgetTracker();
