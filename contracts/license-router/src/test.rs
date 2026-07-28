#![cfg(test)]

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, BytesN, Env, String,
};

use crate::{LicenseRouter, LicenseRouterClient};
use quality_oracle::{QualityOracle, QualityOracleClient};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Register and deploy a Stellar-asset token; mint `amount` to `to`.
fn create_token<'a>(
    env: &Env,
    admin: &Address,
    to: &Address,
    amount: i128,
) -> (Address, TokenClient<'a>) {
    let token_addr = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    StellarAssetClient::new(env, &token_addr).mint(to, &amount);
    let client = TokenClient::new(env, &token_addr);
    (token_addr, client)
}

/// Deploy QualityOracle and return (address, client).
fn deploy_oracle<'a>(env: &Env, admin: &Address) -> (Address, QualityOracleClient<'a>) {
    let addr = env.register(QualityOracle, ());
    let client = QualityOracleClient::new(env, &addr);
    env.mock_all_auths();
    let recovery = Address::generate(env);
    // min_stake = 1_000_000 stroops
    client.initialize(admin, &recovery, &1_000_000);
    (addr, client)
}

/// Deploy LicenseRouter bound to `oracle`; return (address, client).
fn deploy_router<'a>(
    env: &Env,
    admin: &Address,
    oracle: &Address,
) -> (Address, LicenseRouterClient<'a>) {
    let addr = env.register(LicenseRouter, ());
    let client = LicenseRouterClient::new(env, &addr);
    env.mock_all_auths();
    let recovery = Address::generate(env);
    client.initialize(admin, &recovery, oracle);
    (addr, client)
}

/// Register a curator and submit one attestation on `dataset_id` with `score`.
fn attest(
    env: &Env,
    oracle: &QualityOracleClient,
    curator: &Address,
    dataset_id: &String,
    score: u32,
) {
    env.mock_all_auths();
    oracle.register_curator(curator, &1_000_000); // stake = min_stake
    let rubric: BytesN<32> = BytesN::from_array(env, &[0u8; 32]);
    oracle.attest_quality(curator, dataset_id, &score, &rubric);
}

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

struct Fixture<'a> {
    env: Env,
    router: LicenseRouterClient<'a>,
    oracle: QualityOracleClient<'a>,
    token_addr: Address,
    caller: Address,
    recipient: Address,
}

impl<'a> Fixture<'a> {
    fn new() -> Self {
        let env = Env::default();
        env.ledger().with_mut(|li| li.sequence_number = 100);

        let admin = Address::generate(&env);
        let caller = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (oracle_addr, oracle) = deploy_oracle(&env, &admin);
        let (_router_addr, router) = deploy_router(&env, &admin, &oracle_addr);
        let (token_addr, _tok) = create_token(&env, &admin, &caller, 10_000_000);

        Fixture { env, router, oracle, token_addr, caller, recipient }
    }

    fn dataset_id(&self) -> String {
        String::from_str(&self.env, "ds_1")
    }
}

// ---------------------------------------------------------------------------
// Tier tests
// ---------------------------------------------------------------------------

/// No attestation → oracle returns Unrated → 10 000 BPS → 1.0×
#[test]
fn test_route_license_unrated() {
    let f = Fixture::new();
    let dataset_id = f.dataset_id();
    let base: i128 = 1_000_000;

    f.env.mock_all_auths();
    let result = f.router.route_license(
        &f.caller,
        &dataset_id,
        &base,
        &f.token_addr,
        &f.recipient,
    );

    assert_eq!(result.multiplier_bps, 10_000);
    assert_eq!(result.adjusted_amount, base); // 1.0×
    assert_eq!(result.base_amount, base);

    let tok = TokenClient::new(&f.env, &f.token_addr);
    assert_eq!(tok.balance(&f.recipient), base);
    assert_eq!(tok.balance(&f.caller), 10_000_000 - base);
}

/// Score 20 → Bronze → 7 500 BPS → 0.75×
#[test]
fn test_route_license_bronze() {
    let f = Fixture::new();
    let dataset_id = f.dataset_id();
    let curator = Address::generate(&f.env);
    attest(&f.env, &f.oracle, &curator, &dataset_id, 20);

    let base: i128 = 2_000_000;
    f.env.mock_all_auths();
    let result = f.router.route_license(
        &f.caller,
        &dataset_id,
        &base,
        &f.token_addr,
        &f.recipient,
    );

    assert_eq!(result.multiplier_bps, 7_500);
    assert_eq!(result.adjusted_amount, 1_500_000); // 0.75×
}

/// Score 55 → Silver → 10 000 BPS → 1.0×
#[test]
fn test_route_license_silver() {
    let f = Fixture::new();
    let dataset_id = f.dataset_id();
    let curator = Address::generate(&f.env);
    attest(&f.env, &f.oracle, &curator, &dataset_id, 55);

    let base: i128 = 4_000_000;
    f.env.mock_all_auths();
    let result = f.router.route_license(
        &f.caller,
        &dataset_id,
        &base,
        &f.token_addr,
        &f.recipient,
    );

    assert_eq!(result.multiplier_bps, 10_000);
    assert_eq!(result.adjusted_amount, 4_000_000); // 1.0×
}

/// Score 75 → Gold → 12 500 BPS → 1.25×
#[test]
fn test_route_license_gold() {
    let f = Fixture::new();
    let dataset_id = f.dataset_id();
    let curator = Address::generate(&f.env);
    attest(&f.env, &f.oracle, &curator, &dataset_id, 75);

    let base: i128 = 4_000_000;
    f.env.mock_all_auths();
    let result = f.router.route_license(
        &f.caller,
        &dataset_id,
        &base,
        &f.token_addr,
        &f.recipient,
    );

    assert_eq!(result.multiplier_bps, 12_500);
    assert_eq!(result.adjusted_amount, 5_000_000); // 1.25×
}

/// Score 95 → Platinum → 15 000 BPS → 1.5×
#[test]
fn test_route_license_platinum() {
    let f = Fixture::new();
    let dataset_id = f.dataset_id();
    let curator = Address::generate(&f.env);
    attest(&f.env, &f.oracle, &curator, &dataset_id, 95);

    let base: i128 = 2_000_000;
    f.env.mock_all_auths();
    let result = f.router.route_license(
        &f.caller,
        &dataset_id,
        &base,
        &f.token_addr,
        &f.recipient,
    );

    assert_eq!(result.multiplier_bps, 15_000);
    assert_eq!(result.adjusted_amount, 3_000_000); // 1.5×
}

// ---------------------------------------------------------------------------
// View / meta tests
// ---------------------------------------------------------------------------

#[test]
fn test_oracle_address_view() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let admin = Address::generate(&env);
    let (oracle_addr, _) = deploy_oracle(&env, &admin);
    let (_, router) = deploy_router(&env, &admin, &oracle_addr);
    assert_eq!(router.oracle_address(), oracle_addr);
}

#[test]
fn test_version() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let admin = Address::generate(&env);
    let (oracle_addr, _) = deploy_oracle(&env, &admin);
    let (_, router) = deploy_router(&env, &admin, &oracle_addr);
    assert_eq!(router.version(), 3);
}

// ---------------------------------------------------------------------------
// Guard tests
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize_panics() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let admin = Address::generate(&env);
    let (oracle_addr, _) = deploy_oracle(&env, &admin);
    let (_, router) = deploy_router(&env, &admin, &oracle_addr);
    env.mock_all_auths();
    let recovery = Address::generate(&env);
    router.initialize(&admin, &recovery, &oracle_addr); // second call must panic
}

#[test]
#[should_panic(expected = "base_amount must be positive")]
fn test_zero_base_amount_panics() {
    let f = Fixture::new();
    let dataset_id = f.dataset_id();
    f.env.mock_all_auths();
    f.router
        .route_license(&f.caller, &dataset_id, &0, &f.token_addr, &f.recipient);
}
