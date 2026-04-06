#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, token,
    Address, Env, Symbol, Vec, symbol_short,
};

// ---------------------------------------------------------------------------
// Storage key enum
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub struct ReportKey {
    pub reporter: Address,
    pub svc_id: u32,
    pub day_key: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    NextId,
    UsdcAddr,
    Service(u32),
    Report(ReportKey),
}

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SvcInfo {
    pub id: u32,
    pub owner: Address,
    pub url: Symbol,
    pub name: Symbol,
    pub caps: Vec<Symbol>,
    pub price: i128,
    pub protocol: Symbol,
    pub deposit: i128,
    pub status: Symbol,
    pub heartbeat: u32,
    pub score: u32,
    pub reports: u32,
    pub successes: u32,
}

/// Anti-spam deposit amount: 100_000 stroops = $0.01 USDC (7 decimals).
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
        env.storage().instance().set(&DataKey::NextId, &0u32);
        env.storage()
            .instance()
            .set(&DataKey::UsdcAddr, &usdc_addr);
    }

    /// Register a new paid-API service. Requires anti-spam deposit of $0.01 USDC.
    /// Returns the assigned service ID.
    pub fn register_service(
        env: Env,
        owner: Address,
        url: Symbol,
        name: Symbol,
        capabilities: Vec<Symbol>,
        price_stroops: i128,
        protocol: Symbol,
    ) -> u32 {
        owner.require_auth();

        // Transfer deposit from owner -> contract
        let usdc_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcAddr)
            .expect("not initialized");
        let contract_addr = env.current_contract_address();
        token::TokenClient::new(&env, &usdc_addr).transfer(
            &owner,
            &contract_addr,
            &DEPOSIT_AMOUNT,
        );

        // Allocate ID
        let id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .expect("not initialized");
        env.storage().instance().set(&DataKey::NextId, &(id + 1));

        let service = SvcInfo {
            id,
            owner: owner.clone(),
            url,
            name,
            caps: capabilities,
            price: price_stroops,
            protocol,
            deposit: DEPOSIT_AMOUNT,
            status: symbol_short!("active"),
            heartbeat: env.ledger().sequence(),
            score: 70, // default trust score
            reports: 0,
            successes: 0,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Service(id), &service);

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("register")),
            (id, owner),
        );

        id
    }

    /// Deregister a service and refund deposit. Owner authorization required.
    pub fn deregister_service(env: Env, owner: Address, service_id: u32) {
        owner.require_auth();

        let service: SvcInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Service(service_id))
            .expect("service not found");

        if service.owner != owner {
            panic!("not service owner");
        }

        // Refund deposit: contract -> owner
        if service.deposit > 0 {
            let usdc_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::UsdcAddr)
                .expect("not initialized");
            let contract_addr = env.current_contract_address();
            token::TokenClient::new(&env, &usdc_addr).transfer(
                &contract_addr,
                &owner,
                &service.deposit,
            );
        }

        env.storage()
            .persistent()
            .remove(&DataKey::Service(service_id));

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("deregist")),
            (service_id, owner),
        );
    }

    /// Heartbeat: prove the service is still alive. Must be called every ~720 ledgers (~1h).
    pub fn heartbeat(env: Env, owner: Address, service_id: u32) {
        owner.require_auth();

        let mut service: SvcInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Service(service_id))
            .expect("service not found");

        if service.owner != owner {
            panic!("not service owner");
        }

        service.heartbeat = env.ledger().sequence();
        service.status = symbol_short!("active");

        env.storage()
            .persistent()
            .set(&DataKey::Service(service_id), &service);
    }

    /// Report quality for a service. Max 1 report per (reporter, service, day).
    pub fn report_quality(env: Env, reporter: Address, service_id: u32, success: bool) {
        reporter.require_auth();

        let mut service: SvcInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Service(service_id))
            .expect("service not found");

        // Enforce max 1 report per (reporter, service_id, day)
        let day_key = env.ledger().timestamp() / 86400;
        let report_key = DataKey::Report(ReportKey {
            reporter: reporter.clone(),
            svc_id: service_id,
            day_key,
        });

        if env.storage().temporary().has(&report_key) {
            panic!("already reported today");
        }
        env.storage().temporary().set(&report_key, &true);
        // TTL: extend so it lasts at least the rest of the day (~17280 ledgers = 24h)
        env.storage()
            .temporary()
            .extend_ttl(&report_key, 17280, 17280);

        // Update report counts
        service.reports += 1;
        if success {
            service.successes += 1;
        }

        // Recalculate trust score
        if service.reports > 0 {
            service.score = service.successes * 100 / service.reports;
        } else {
            service.score = 70;
        }

        env.storage()
            .persistent()
            .set(&DataKey::Service(service_id), &service);

        env.events().publish(
            (symbol_short!("registry"), symbol_short!("quality")),
            (service_id, reporter, success),
        );
    }

    /// List services filtered by capability and minimum trust score.
    /// Only returns active or stale services.
    pub fn list_services(env: Env, capability: Symbol, min_score: u32) -> Vec<SvcInfo> {
        let next_id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(0);
        let mut result = Vec::new(&env);

        for i in 0..next_id {
            if let Some(service) =
                env.storage()
                    .persistent()
                    .get::<DataKey, SvcInfo>(&DataKey::Service(i))
            {
                // Only active or stale
                if service.status != symbol_short!("active")
                    && service.status != symbol_short!("stale")
                {
                    continue;
                }

                // Score filter
                if service.score < min_score {
                    continue;
                }

                // Capability filter
                if service.caps.contains(&capability) {
                    result.push_back(service);
                }
            }
        }

        result
    }

    /// Get a single service by ID.
    pub fn get_service(env: Env, service_id: u32) -> SvcInfo {
        env.storage()
            .persistent()
            .get(&DataKey::Service(service_id))
            .expect("service not found")
    }

    /// Permissionless staleness check. Anyone can call.
    /// >720 ledgers since heartbeat = stale.
    /// >7200 ledgers = removed + deposit forfeited to admin.
    pub fn check_stale(env: Env, service_id: u32) {
        let mut service: SvcInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Service(service_id))
            .expect("service not found");

        let current_seq = env.ledger().sequence();
        let gap = current_seq.saturating_sub(service.heartbeat);

        if gap > 7200 {
            // Removed: forfeit deposit to admin
            if service.deposit > 0 {
                let usdc_addr: Address = env
                    .storage()
                    .instance()
                    .get(&DataKey::UsdcAddr)
                    .expect("not initialized");
                let admin: Address = env
                    .storage()
                    .instance()
                    .get(&DataKey::Admin)
                    .expect("not initialized");
                let contract_addr = env.current_contract_address();
                token::TokenClient::new(&env, &usdc_addr).transfer(
                    &contract_addr,
                    &admin,
                    &service.deposit,
                );
                service.deposit = 0;
            }
            service.status = symbol_short!("removed");
            env.storage()
                .persistent()
                .set(&DataKey::Service(service_id), &service);

            env.events().publish(
                (symbol_short!("registry"), symbol_short!("removed")),
                service_id,
            );
        } else if gap > 720 {
            service.status = symbol_short!("stale");
            env.storage()
                .persistent()
                .set(&DataKey::Service(service_id), &service);

            env.events().publish(
                (symbol_short!("registry"), symbol_short!("stale")),
                service_id,
            );
        }
    }
}
