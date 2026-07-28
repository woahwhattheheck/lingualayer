#![cfg_attr(not(test), no_std)]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, String, Vec,
};

const MAX_SCORE: u32 = 100;
// Default minimum stake: 1 XLM expressed in stroops
const MIN_STAKE_DEFAULT: u64 = 10_000_000;

// ---------------------------------------------------------------------------
// Storage key types (typed keys avoid format! which is unavailable in no_std)
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
enum StorageKey {
    Curator(Address),
    Attestation(String, Address),
    Quality(String),
    CuratorList,
    CuratorStats(Address),
}

// ---------------------------------------------------------------------------
// Public data types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug)]
pub struct CuratorRecord {
    pub stake: u64,
    pub slashed: bool,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct QualityAttestation {
    pub dataset_id: String,
    pub curator: Address,
    pub score: u32,
    pub rubric_hash: BytesN<32>,
    pub ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct DatasetQuality {
    pub dataset_id: String,
    pub average_score: u32,
    pub attestation_count: u32,
    pub last_updated_ledger: u32,
    pub tier: QualityTier,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum QualityTier {
    Unrated,
    Bronze,
    Silver,
    Gold,
    Platinum,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct CuratorStats {
    pub curator: Address,
    pub attestation_count: u32,
    pub average_score: u32,
    pub tier: QualityTier,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct QualityOracle;

#[contractimpl]
impl QualityOracle {
    /// Initialise the contract. `min_stake` is the minimum stroops a curator
    /// must commit when registering — this is the amount at risk of slashing.
    /// `recovery` is a separate address that can force an admin handoff via
    /// `recovery_takeover` without the current admin's cooperation — see
    /// the `access-control` crate's docs for why this exists and why it
    /// must differ from `admin`.
    pub fn initialize(env: Env, admin: Address, recovery: Address, min_stake: u64) {
        access_control::init(&env, &admin, &recovery);
        env.storage().instance().set(&symbol_short!("cur_cnt"), &0u32);
        env.storage().instance().set(&symbol_short!("min_stk"), &min_stake);
    }

    /// Current admin proposes `new_admin`. Takes effect only once
    /// `new_admin` calls `accept_admin` themselves.
    pub fn propose_admin(env: Env, new_admin: Address) {
        access_control::propose_admin(&env, &new_admin);
    }

    /// The pending admin accepts the role. Returns the new admin address.
    pub fn accept_admin(env: Env) -> Address {
        access_control::accept_admin(&env)
    }

    /// Emergency handoff: the recovery address forces admin to `new_admin`
    /// immediately, with no cooperation required from the current admin.
    pub fn recovery_takeover(env: Env, new_admin: Address) {
        access_control::recovery_takeover(&env, &new_admin);
    }

    /// Current admin rotates the recovery address.
    pub fn set_recovery(env: Env, new_recovery: Address) {
        access_control::set_recovery(&env, &new_recovery);
    }

    pub fn admin(env: Env) -> Address {
        access_control::admin(&env)
    }

    pub fn recovery_address(env: Env) -> Address {
        access_control::recovery(&env)
    }

    pub fn pending_admin(env: Env) -> Option<Address> {
        access_control::pending_admin(&env)
    }

    /// Register as a curator with an on-chain stake commitment.
    /// `stake` must be >= the configured minimum stake.
    pub fn register_curator(env: Env, curator: Address, stake: u64) {
        curator.require_auth();
        let min: u64 = env
            .storage()
            .instance()
            .get(&symbol_short!("min_stk"))
            .unwrap_or(MIN_STAKE_DEFAULT);
        if stake < min {
            panic!("stake below minimum");
        }
        let key = StorageKey::Curator(curator.clone());
        if env.storage().persistent().has(&key) {
            panic!("curator already registered");
        }
        let record = CuratorRecord { stake, slashed: false };
        env.storage().persistent().set(&key, &record);
        env.storage()
            .persistent()
            .extend_ttl(&key, 7_776_000, 7_776_000);
        let cnt: u32 = env
            .storage()
            .instance()
            .get(&symbol_short!("cur_cnt"))
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&symbol_short!("cur_cnt"), &(cnt + 1));

        // Track registration order for the curator leaderboard.
        let mut curators: Vec<Address> = env
            .storage()
            .instance()
            .get(&StorageKey::CuratorList)
            .unwrap_or(Vec::new(&env));
        curators.push_back(curator);
        env.storage()
            .instance()
            .set(&StorageKey::CuratorList, &curators);
    }

    /// Admin slashes a curator for malicious attestations. Zeroes their stake
    /// and permanently bars them from submitting further attestations.
    pub fn slash_curator(env: Env, admin: Address, curator: Address) {
        access_control::require_admin(&env, &admin);
        let key = StorageKey::Curator(curator.clone());
        let mut record: CuratorRecord = env
            .storage()
            .persistent()
            .get(&key)
            .expect("curator not found");
        if record.slashed {
            panic!("already slashed");
        }
        let slashed_stake = record.stake;
        record.stake = 0;
        record.slashed = true;
        env.storage().persistent().set(&key, &record);
        env.events()
            .publish((symbol_short!("slash"), curator), slashed_stake);
    }

    /// Returns the current stake amount for a curator (0 if not registered or slashed).
    pub fn get_curator_stake(env: Env, curator: Address) -> u64 {
        let key = StorageKey::Curator(curator);
        let maybe: Option<CuratorRecord> = env.storage().persistent().get(&key);
        maybe.map(|r| r.stake).unwrap_or(0)
    }

    pub fn attest_quality(
        env: Env,
        curator: Address,
        dataset_id: String,
        score: u32,
        rubric_hash: BytesN<32>,
    ) {
        curator.require_auth();
        let cur_key = StorageKey::Curator(curator.clone());
        let record: CuratorRecord = env
            .storage()
            .persistent()
            .get(&cur_key)
            .expect("curator not registered");
        if record.slashed {
            panic!("curator is slashed");
        }
        if score > MAX_SCORE {
            panic!("score must be 0-100");
        }

        let attest = QualityAttestation {
            dataset_id: dataset_id.clone(),
            curator: curator.clone(),
            score,
            rubric_hash,
            ledger: env.ledger().sequence(),
        };
        let attest_key = StorageKey::Attestation(dataset_id.clone(), curator.clone());
        env.storage().persistent().set(&attest_key, &attest);
        env.storage()
            .persistent()
            .extend_ttl(&attest_key, 7_776_000, 7_776_000);

        let agg_key = StorageKey::Quality(dataset_id.clone());
        let mut quality: DatasetQuality = env
            .storage()
            .persistent()
            .get(&agg_key)
            .unwrap_or(DatasetQuality {
                dataset_id: dataset_id.clone(),
                average_score: 0,
                attestation_count: 0,
                last_updated_ledger: 0,
                tier: QualityTier::Unrated,
            });

        let new_total = quality.average_score as u64
            * quality.attestation_count as u64
            + score as u64;
        quality.attestation_count += 1;
        quality.average_score = (new_total / quality.attestation_count as u64) as u32;
        quality.last_updated_ledger = env.ledger().sequence();
        quality.tier = Self::compute_tier(quality.average_score);

        env.storage().persistent().set(&agg_key, &quality);
        env.storage()
            .persistent()
            .extend_ttl(&agg_key, 7_776_000, 7_776_000);

        // Update the curator's aggregate stats for the leaderboard.
        let stats_key = StorageKey::CuratorStats(curator.clone());
        let mut stats: CuratorStats =
            env.storage()
                .persistent()
                .get(&stats_key)
                .unwrap_or(CuratorStats {
                    curator: curator.clone(),
                    attestation_count: 0,
                    average_score: 0,
                    tier: QualityTier::Unrated,
                });

        let stats_total =
            stats.average_score as u64 * stats.attestation_count as u64 + score as u64;
        stats.attestation_count += 1;
        stats.average_score = (stats_total / stats.attestation_count as u64) as u32;
        stats.tier = Self::compute_tier(stats.average_score);

        env.storage().persistent().set(&stats_key, &stats);
        env.storage()
            .persistent()
            .extend_ttl(&stats_key, 7_776_000, 7_776_000);
    }

    pub fn get_quality(env: Env, dataset_id: String) -> DatasetQuality {
        let agg_key = StorageKey::Quality(dataset_id);
        env.storage()
            .persistent()
            .get(&agg_key)
            .expect("no quality data")
    }

    /// Every curator address that has ever called `register_curator`, in registration order.
    pub fn list_curators(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&StorageKey::CuratorList)
            .unwrap_or(Vec::new(&env))
    }

    /// Aggregate activity/reliability stats for one curator, used to build the leaderboard.
    pub fn get_curator_stats(env: Env, curator: Address) -> CuratorStats {
        env.storage()
            .persistent()
            .get(&StorageKey::CuratorStats(curator.clone()))
            .unwrap_or(CuratorStats {
                curator,
                attestation_count: 0,
                average_score: 0,
                tier: QualityTier::Unrated,
            })
    }

    /// Returns the royalty multiplier for `dataset_id` in basis points.
    ///
    /// | Tier     | BPS    | Effective rate |
    /// |----------|--------|----------------|
    /// | Unrated  | 10 000 | 1.0×           |
    /// | Bronze   |  7 500 | 0.75×          |
    /// | Silver   | 10 000 | 1.0×           |
    /// | Gold     | 12 500 | 1.25×          |
    /// | Platinum | 15 000 | 1.5×           |
    pub fn royalty_multiplier_bps(env: Env, dataset_id: String) -> u32 {
        let agg_key = StorageKey::Quality(dataset_id);
        match env
            .storage()
            .persistent()
            .get::<StorageKey, DatasetQuality>(&agg_key)
        {
            Some(q) => match q.tier {
                QualityTier::Platinum => 15_000,
                QualityTier::Gold => 12_500,
                QualityTier::Silver => 10_000,
                QualityTier::Bronze => 7_500,
                QualityTier::Unrated => 10_000,
            },
            None => 10_000,
        }
    }

    fn compute_tier(score: u32) -> QualityTier {
        match score {
            0 => QualityTier::Unrated,
            1..=39 => QualityTier::Bronze,
            40..=69 => QualityTier::Silver,
            70..=84 => QualityTier::Gold,
            _ => QualityTier::Platinum,
        }
    }

    pub fn version(_env: Env) -> u32 {
        3
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    fn setup(env: &Env) -> (QualityOracleClient, Address) {
        env.mock_all_auths();
        let id = env.register_contract(None, QualityOracle);
        let client = QualityOracleClient::new(env, &id);
        let admin = Address::generate(env);
        client.initialize(&admin, &1_000_000);
        (client, admin)
    }

    #[test]
    fn test_register_stores_stake() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let curator = Address::generate(&env);
        client.register_curator(&curator, &2_000_000);
        assert_eq!(client.get_curator_stake(&curator), 2_000_000);
    }

    #[test]
    fn test_slash_zeroes_stake() {
        let env = Env::default();
        let (client, admin) = setup(&env);
        let curator = Address::generate(&env);
        client.register_curator(&curator, &5_000_000);
        client.slash_curator(&admin, &curator);
        assert_eq!(client.get_curator_stake(&curator), 0);
    }

    #[test]
    #[should_panic(expected = "curator is slashed")]
    fn test_slashed_curator_cannot_attest() {
        let env = Env::default();
        let (client, admin) = setup(&env);
        let curator = Address::generate(&env);
        client.register_curator(&curator, &1_000_000);
        client.slash_curator(&admin, &curator);
        let ds = soroban_sdk::String::from_str(&env, "ds-001");
        let hash = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);
        client.attest_quality(&curator, &ds, &75, &hash);
    }

    #[test]
    #[should_panic(expected = "unauthorized")]
    fn test_non_admin_cannot_slash() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let curator = Address::generate(&env);
        let impostor = Address::generate(&env);
        client.register_curator(&curator, &1_000_000);
        client.slash_curator(&impostor, &curator);
    }

    #[test]
    #[should_panic(expected = "stake below minimum")]
    fn test_stake_below_minimum_rejected() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let curator = Address::generate(&env);
        client.register_curator(&curator, &500_000);
    }

    #[test]
    fn test_attest_and_get_quality() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let curator = Address::generate(&env);
        client.register_curator(&curator, &1_000_000);
        let ds = soroban_sdk::String::from_str(&env, "ds-gold");
        let hash = soroban_sdk::BytesN::from_array(&env, &[1u8; 32]);
        client.attest_quality(&curator, &ds, &80, &hash);
        let q = client.get_quality(&ds);
        assert_eq!(q.average_score, 80);
        assert_eq!(q.tier, QualityTier::Gold);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::BytesN;

    fn hash(env: &Env, byte: u8) -> BytesN<32> {
        BytesN::from_array(env, &[byte; 32])
    }

    #[test]
    fn list_curators_tracks_registration_order() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QualityOracle);
        let client = QualityOracleClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin, &1_000_000);

        let curator_a = Address::generate(&env);
        let curator_b = Address::generate(&env);
        client.register_curator(&curator_a, &1_000_000);
        client.register_curator(&curator_b, &1_000_000);

        let curators = client.list_curators();
        assert_eq!(curators.len(), 2);
        assert_eq!(curators.get(0).unwrap(), curator_a);
        assert_eq!(curators.get(1).unwrap(), curator_b);
    }

    #[test]
    fn curator_stats_aggregate_across_datasets() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QualityOracle);
        let client = QualityOracleClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin, &1_000_000);

        let curator = Address::generate(&env);
        client.register_curator(&curator, &1_000_000);

        let dataset_a = String::from_str(&env, "yo-proverbs-001");
        let dataset_b = String::from_str(&env, "sw-news-002");

        client.attest_quality(&curator, &dataset_a, &80, &hash(&env, 1));
        client.attest_quality(&curator, &dataset_b, &60, &hash(&env, 2));

        let stats = client.get_curator_stats(&curator);
        assert_eq!(stats.attestation_count, 2);
        assert_eq!(stats.average_score, 70);
        assert_eq!(stats.tier, QualityTier::Gold);
    }

    #[test]
    fn curator_stats_defaults_for_unknown_curator() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QualityOracle);
        let client = QualityOracleClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin, &1_000_000);

        let stranger = Address::generate(&env);
        let stats = client.get_curator_stats(&stranger);
        assert_eq!(stats.attestation_count, 0);
        assert_eq!(stats.average_score, 0);
        assert_eq!(stats.tier, QualityTier::Unrated);
    }

    #[test]
    #[should_panic(expected = "curator already registered")]
    fn register_curator_twice_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QualityOracle);
        let client = QualityOracleClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin, &1_000_000);

        let curator = Address::generate(&env);
        client.register_curator(&curator, &1_000_000);
        client.register_curator(&curator, &1_000_000);
    }
}
