#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, token,
    Address, Env, String, Symbol, Vec,
};

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceInfo {
    pub id: u32,
    pub owner: Address,
    pub url: String,
    pub name: Symbol,
    pub capability: Symbol,
    pub price: i128,
    pub protocol: Symbol,
    pub score: u32,
    pub total_reports: u32,
    pub successful_reports: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct DepositRecord {
    pub owner: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    UsdcAddr,
    NextId,
    Service(u32),
    CapIndex(Symbol),
    Deposit(u32),
    QualityReport(Address, u32),
}

/// Anti-spam deposit: 100,000 stroops ($0.01 USDC, 7 decimals).
const DEPOSIT_AMOUNT: i128 = 100_000;

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct TrustRegistry;

#[contractimpl]
impl TrustRegistry {
    /// One-time initialization. Sets admin and USDC SAC address.
    pub fn initialize(env: Env, admin: Address, usdc_addr: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::UsdcAddr, &usdc_addr);
        env.storage().instance().set(&DataKey::NextId, &0u32);
        env.storage().instance().extend_ttl(100_000, 100_000);
    }

    /// Register a new paid-API service. Requires anti-spam deposit of $0.01 USDC.
    /// Returns the assigned service ID.
    ///
    /// NOTE: Each registration covers ONE capability. To register a service
    /// with multiple capabilities, call register_service once per capability.
    /// Each call assigns a new ID, collects a separate deposit, and requires
    /// its own heartbeat. The same URL appearing in multiple CapIndex entries
    /// is expected and correct behavior.
    pub fn register_service(
        env: Env,
        owner: Address,
        url: String,
        name: Symbol,
        capability: Symbol,
        price: i128,
        protocol: Symbol,
    ) -> u32 {
        owner.require_auth();

        // Collect anti-spam deposit via SAC transfer
        let usdc_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcAddr)
            .expect("contract not initialized");
        token::TokenClient::new(&env, &usdc_addr).transfer(
            &owner,
            &env.current_contract_address(),
            &DEPOSIT_AMOUNT,
        );

        // Assign ID from counter (guard against u32 overflow)
        let id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .expect("contract not initialized");
        if id == u32::MAX {
            panic!("service ID space exhausted");
        }

        // Check for duplicate URL within this capability
        let cap_key = DataKey::CapIndex(capability.clone());
        let mut cap_ids: Vec<u32> = env
            .storage()
            .persistent()
            .get(&cap_key)
            .unwrap_or(Vec::new(&env));
        for existing_id in cap_ids.iter() {
            if let Some(existing) = env
                .storage()
                .temporary()
                .get::<_, ServiceInfo>(&DataKey::Service(existing_id))
            {
                if existing.url == url {
                    panic!("service with this URL already registered in this capability");
                }
            }
        }

        let info = ServiceInfo {
            id,
            owner: owner.clone(),
            url,
            name,
            capability: capability.clone(),
            price,
            protocol,
            score: 70,
            total_reports: 0,
            successful_reports: 0,
        };

        // Store service in TEMPORARY storage (5 min TTL = 60 ledgers)
        env.storage().temporary().set(&DataKey::Service(id), &info);
        env.storage()
            .temporary()
            .extend_ttl(&DataKey::Service(id), 60, 60);

        // Store deposit with owner info in PERSISTENT (for refund on deregister or reclaim)
        let deposit_record = DepositRecord {
            owner: owner.clone(),
            amount: DEPOSIT_AMOUNT,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Deposit(id), &deposit_record);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Deposit(id), 100_000, 100_000);

        // Add to capability index in PERSISTENT
        cap_ids.push_back(id);
        env.storage().persistent().set(&cap_key, &cap_ids);
        env.storage()
            .persistent()
            .extend_ttl(&cap_key, 100_000, 100_000);

        // Increment counter
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        env.storage().instance().extend_ttl(100_000, 100_000);

        env.events()
            .publish((Symbol::new(&env, "register"), capability), id);

        id
    }

    /// Heartbeat: extend service TTL and clean dead entries from capability index.
    pub fn heartbeat(env: Env, service_id: u32) {
        let info: ServiceInfo = env
            .storage()
            .temporary()
            .get(&DataKey::Service(service_id))
            .expect("service expired or not found, re-register");

        info.owner.require_auth();

        // Extend TTL to 15 min (180 ledgers)
        env.storage()
            .temporary()
            .extend_ttl(&DataKey::Service(service_id), 180, 180);

        // Clean dead entries from this capability's index
        let cap_key = DataKey::CapIndex(info.capability.clone());
        let cap_ids: Vec<u32> = env
            .storage()
            .persistent()
            .get(&cap_key)
            .unwrap_or(Vec::new(&env));

        let mut clean_ids = Vec::new(&env);
        for id in cap_ids.iter() {
            if env.storage().temporary().has(&DataKey::Service(id)) {
                clean_ids.push_back(id);
            }
        }

        // Only write back if dead entries were actually removed
        if clean_ids.len() != cap_ids.len() {
            env.storage().persistent().set(&cap_key, &clean_ids);
            env.storage()
                .persistent()
                .extend_ttl(&cap_key, 100_000, 100_000);
        }
    }

    /// Deregister a service. Removes from temporary + CapIndex. Refunds deposit.
    pub fn deregister_service(env: Env, service_id: u32) {
        let info: ServiceInfo = env
            .storage()
            .temporary()
            .get(&DataKey::Service(service_id))
            .expect("service not found");

        info.owner.require_auth();

        // Remove from temporary storage
        env.storage()
            .temporary()
            .remove(&DataKey::Service(service_id));

        // Remove from capability index (also clean any other dead entries)
        let cap_key = DataKey::CapIndex(info.capability.clone());
        let cap_ids: Vec<u32> = env
            .storage()
            .persistent()
            .get(&cap_key)
            .unwrap_or(Vec::new(&env));
        let mut cleaned = Vec::new(&env);
        for id in cap_ids.iter() {
            if id != service_id {
                cleaned.push_back(id);
            }
        }
        env.storage().persistent().set(&cap_key, &cleaned);
        env.storage()
            .persistent()
            .extend_ttl(&cap_key, 100_000, 100_000);

        // Refund deposit
        let deposit_key = DataKey::Deposit(service_id);
        if let Some(record) = env
            .storage()
            .persistent()
            .get::<_, DepositRecord>(&deposit_key)
        {
            if record.amount > 0 {
                let usdc_addr: Address = env
                    .storage()
                    .instance()
                    .get(&DataKey::UsdcAddr)
                    .expect("contract not initialized");
                token::TokenClient::new(&env, &usdc_addr).transfer(
                    &env.current_contract_address(),
                    &info.owner,
                    &record.amount,
                );
            }
            env.storage().persistent().remove(&deposit_key);
        }

        env.events().publish(
            (Symbol::new(&env, "deregister"), info.capability),
            service_id,
        );
    }

    /// List services filtered by capability, minimum score, and limit.
    /// Also cleans dead entries from the capability index.
    pub fn list_services(
        env: Env,
        capability: Symbol,
        min_score: u32,
        limit: u32,
    ) -> Vec<ServiceInfo> {
        let cap_key = DataKey::CapIndex(capability);
        let cap_ids: Vec<u32> = env
            .storage()
            .persistent()
            .get(&cap_key)
            .unwrap_or(Vec::new(&env));

        let mut results = Vec::new(&env);
        let mut live_ids = Vec::new(&env);

        for id in cap_ids.iter() {
            match env
                .storage()
                .temporary()
                .get::<_, ServiceInfo>(&DataKey::Service(id))
            {
                Some(info) => {
                    live_ids.push_back(id);
                    if info.score >= min_score && results.len() < limit {
                        results.push_back(info);
                    }
                }
                None => {
                    // Expired — not added to live_ids = cleaned from index
                }
            }
        }

        // Write cleaned index only if dead entries were found
        if live_ids.len() != cap_ids.len() {
            env.storage().persistent().set(&cap_key, &live_ids);
            env.storage()
                .persistent()
                .extend_ttl(&cap_key, 100_000, 100_000);
        }

        results
    }

    /// Get a single service by ID.
    pub fn get_service(env: Env, service_id: u32) -> ServiceInfo {
        env.storage()
            .temporary()
            .get(&DataKey::Service(service_id))
            .expect("service not found or expired")
    }

    /// Report quality for a service. Max 1 report per (reporter, service_id) per day.
    pub fn report_quality(env: Env, reporter: Address, service_id: u32, success: bool) {
        reporter.require_auth();

        let mut info: ServiceInfo = env
            .storage()
            .temporary()
            .get(&DataKey::Service(service_id))
            .expect("service not found");

        // Rate limit: 1 report per reporter per service per day
        let day_key = env.ledger().timestamp() / 86400;
        let report_key = DataKey::QualityReport(reporter.clone(), service_id);
        let last_day: u32 = env.storage().temporary().get(&report_key).unwrap_or(0);
        if last_day == day_key as u32 {
            panic!("already reported today");
        }
        env.storage()
            .temporary()
            .set(&report_key, &(day_key as u32));
        env.storage()
            .temporary()
            .extend_ttl(&report_key, 17280, 17280);

        // Update score
        info.total_reports += 1;
        if success {
            info.successful_reports += 1;
        }
        info.score = if info.total_reports > 0 {
            (info.successful_reports * 100) / info.total_reports
        } else {
            70
        };

        env.storage()
            .temporary()
            .set(&DataKey::Service(service_id), &info);
        // TTL NOT extended — only heartbeat extends service TTL
    }

    /// Reclaim deposit after a service has expired (crash recovery).
    /// Only the original owner can reclaim. The service must have expired.
    pub fn reclaim_deposit(env: Env, service_id: u32, owner: Address) {
        owner.require_auth();

        // Service must have expired (no longer in temporary storage)
        if env
            .storage()
            .temporary()
            .has(&DataKey::Service(service_id))
        {
            panic!("service is still active, use deregister_service instead");
        }

        // Read deposit record and verify ownership
        let deposit_key = DataKey::Deposit(service_id);
        let record: DepositRecord = env
            .storage()
            .persistent()
            .get(&deposit_key)
            .expect("no deposit found for this service ID");

        if record.owner != owner {
            panic!("only the original owner can reclaim the deposit");
        }

        if record.amount <= 0 {
            panic!("deposit already reclaimed");
        }

        // Refund
        let usdc_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcAddr)
            .expect("contract not initialized");
        token::TokenClient::new(&env, &usdc_addr).transfer(
            &env.current_contract_address(),
            &owner,
            &record.amount,
        );

        // Remove deposit record
        env.storage().persistent().remove(&deposit_key);

        env.events().publish(
            (Symbol::new(&env, "reclaim"),),
            (service_id, owner, record.amount),
        );
    }
}
