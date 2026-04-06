#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype,
    Address, Env, Symbol, Vec, symbol_short,
};

// ---------------------------------------------------------------------------
// Storage key enum
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Policy,
    Owner,
    Allowlist,
    DeniedCnt,
    Spend(u64),
    Nonce(Symbol),
    TotalSpent,
    TxCount,
}

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Policy {
    pub daily_lim: i128,
    pub per_tx_lim: i128,
    pub rate_limit: u32,
    pub time_start: u64,
    pub time_end: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpendRec {
    pub total: i128,
    pub count: u64,
    pub last_min: u64,
    pub min_count: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyRes {
    pub allowed: bool,
    pub reason: Symbol,
    pub remaining: i128,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct WalletPolicy;

#[contractimpl]
impl WalletPolicy {
    /// One-time initialization. Sets policy parameters, owner, and empty allowlist.
    pub fn initialize(
        env: Env,
        owner: Address,
        daily_limit: i128,
        per_tx_limit: i128,
        rate_limit: u32,
    ) {
        // Prevent re-initialization
        if env.storage().instance().has(&DataKey::Owner) {
            panic!("already initialized");
        }

        let policy = Policy {
            daily_lim: daily_limit,
            per_tx_lim: per_tx_limit,
            rate_limit,
            time_start: 0,
            time_end: 0,
        };

        env.storage().instance().set(&DataKey::Policy, &policy);
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage()
            .instance()
            .set(&DataKey::Allowlist, &Vec::<Address>::new(&env));
        env.storage().instance().set(&DataKey::DeniedCnt, &0u64);

        // Lifetime stats
        env.storage().persistent().set(&DataKey::TotalSpent, &0i128);
        env.storage().persistent().set(&DataKey::TxCount, &0u64);
    }

    /// READ-ONLY policy check. Does NOT modify state.
    /// Returns allowed/denied + reason + remaining daily budget (stroops).
    pub fn check_policy(env: Env, amount: i128, recipient: Address) -> PolicyRes {
        let policy: Policy = env
            .storage()
            .instance()
            .get(&DataKey::Policy)
            .expect("not initialized");

        let now = env.ledger().timestamp();
        let day_key = now / 86400;
        let record = Self::load_spend(&env, day_key);
        let remaining = policy.daily_lim - record.total;

        // --- per-tx limit ---
        if amount > policy.per_tx_lim {
            return PolicyRes {
                allowed: false,
                reason: Symbol::new(&env, "over_per_tx"),
                remaining,
            };
        }

        // --- time window ---
        if policy.time_start > 0 && now < policy.time_start {
            return PolicyRes {
                allowed: false,
                reason: Symbol::new(&env, "before_window"),
                remaining,
            };
        }
        if policy.time_end > 0 && now > policy.time_end {
            return PolicyRes {
                allowed: false,
                reason: Symbol::new(&env, "after_window"),
                remaining,
            };
        }

        // --- daily limit ---
        if record.total + amount > policy.daily_lim {
            return PolicyRes {
                allowed: false,
                reason: Symbol::new(&env, "over_daily"),
                remaining,
            };
        }

        // --- rate limit (per minute) ---
        if policy.rate_limit > 0 {
            let current_min = now / 60;
            if current_min == record.last_min && record.min_count >= policy.rate_limit {
                return PolicyRes {
                    allowed: false,
                    reason: Symbol::new(&env, "rate_limited"),
                    remaining,
                };
            }
        }

        // --- allowlist ---
        let allowlist: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Allowlist)
            .unwrap_or(Vec::new(&env));

        if !allowlist.is_empty() && !allowlist.contains(&recipient) {
            return PolicyRes {
                allowed: false,
                reason: symbol_short!("bad_recv"),
                remaining,
            };
        }

        PolicyRes {
            allowed: true,
            reason: symbol_short!("ok"),
            remaining,
        }
    }

    /// Record a successful spend. Panics on duplicate nonce (idempotency guard).
    /// Requires owner authorization.
    pub fn record_spend(
        env: Env,
        nonce: Symbol,
        amount: i128,
        recipient: Address,
        tx_hash: Symbol,
    ) {
        let owner: Address = env
            .storage()
            .instance()
            .get(&DataKey::Owner)
            .expect("not initialized");
        owner.require_auth();

        // --- nonce dedup ---
        let nonce_key = DataKey::Nonce(nonce.clone());
        if env.storage().persistent().has(&nonce_key) {
            panic!("duplicate nonce");
        }
        env.storage().persistent().set(&nonce_key, &true);

        // --- update daily spend ---
        let now = env.ledger().timestamp();
        let day_key = now / 86400;
        let current_min = now / 60;

        let mut record = Self::load_spend(&env, day_key);

        record.total += amount;
        record.count += 1;
        if current_min == record.last_min {
            record.min_count += 1;
        } else {
            record.last_min = current_min;
            record.min_count = 1;
        }

        env.storage()
            .persistent()
            .set(&DataKey::Spend(day_key), &record);

        // --- update lifetime stats ---
        let total_spent: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalSpent)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::TotalSpent, &(total_spent + amount));

        let tx_count: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::TxCount)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::TxCount, &(tx_count + 1));

        // --- emit event ---
        env.events().publish(
            (symbol_short!("spend"), symbol_short!("ok")),
            (amount, recipient, tx_hash),
        );
    }

    /// Record a denied payment attempt. Requires owner authorization.
    pub fn record_denied(env: Env, amount: i128, reason: Symbol) {
        let owner: Address = env
            .storage()
            .instance()
            .get(&DataKey::Owner)
            .expect("not initialized");
        owner.require_auth();

        let denied: u64 = env
            .storage()
            .instance()
            .get(&DataKey::DeniedCnt)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::DeniedCnt, &(denied + 1));

        env.events().publish(
            (symbol_short!("spend"), symbol_short!("denied")),
            (amount, reason),
        );
    }

    /// Update the spending policy. Owner authorization required.
    pub fn update_policy(
        env: Env,
        daily_limit: i128,
        per_tx_limit: i128,
        rate_limit: u32,
        time_start: u64,
        time_end: u64,
    ) {
        let owner: Address = env
            .storage()
            .instance()
            .get(&DataKey::Owner)
            .expect("not initialized");
        owner.require_auth();

        let policy = Policy {
            daily_lim: daily_limit,
            per_tx_lim: per_tx_limit,
            rate_limit,
            time_start,
            time_end,
        };
        env.storage().instance().set(&DataKey::Policy, &policy);
    }

    /// Replace the recipient allowlist. Empty = allow all. Owner auth required.
    pub fn set_allowlist(env: Env, addresses: Vec<Address>) {
        let owner: Address = env
            .storage()
            .instance()
            .get(&DataKey::Owner)
            .expect("not initialized");
        owner.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::Allowlist, &addresses);
    }

    /// Get today's spend record (total, count, rate info).
    pub fn get_today_spending(env: Env) -> SpendRec {
        let day_key = env.ledger().timestamp() / 86400;
        Self::load_spend(&env, day_key)
    }

    /// Get lifetime stats: (total_spent, tx_count, denied_count).
    pub fn get_lifetime_stats(env: Env) -> (i128, u64, u64) {
        let total_spent: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalSpent)
            .unwrap_or(0);
        let tx_count: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::TxCount)
            .unwrap_or(0);
        let denied: u64 = env
            .storage()
            .instance()
            .get(&DataKey::DeniedCnt)
            .unwrap_or(0);
        (total_spent, tx_count, denied)
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    fn load_spend(env: &Env, day_key: u64) -> SpendRec {
        env.storage()
            .persistent()
            .get(&DataKey::Spend(day_key))
            .unwrap_or(SpendRec {
                total: 0,
                count: 0,
                last_min: 0,
                min_count: 0,
            })
    }
}
