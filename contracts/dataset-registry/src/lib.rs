#![cfg_attr(not(test), no_std)]
#[cfg(not(test))]
extern crate alloc;

#[cfg(not(test))]
use alloc::format;
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, String, Symbol, Vec,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DatasetState {
    Active,
    Deprecated,
    UnderReview,
}

/// Payload published with the `("dataset", "registered")` event topic.
///
/// This is the on-chain provenance record the off-chain indexer subscribes to
/// (see `apps/backend/src/indexer`). Every field here is what the indexer needs
/// to materialize a row without re-reading contract storage, so the event is
/// intentionally self-contained.
#[contracttype]
#[derive(Clone, Debug)]
pub struct DatasetRegisteredEvent {
    pub id: String,
    pub owner: Address,
    pub language_code: String,
    pub name: String,
    pub metadata_hash: soroban_sdk::BytesN<32>,
    pub version: u32,
    pub sample_count: u32,
    pub duration_seconds: u32,
    pub commission_id: Option<String>,
    pub created_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ContributorShare {
    pub address: Address,
    pub share_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Dataset {
    pub id: String,
    pub owner: Address,
    pub language_code: String,
    pub name: String,
    pub metadata_hash: soroban_sdk::BytesN<32>,
    pub version: u32,
    pub state: DatasetState,
    pub contributors: Vec<ContributorShare>,
    pub created_ledger: u32,
    pub sample_count: u32,
    pub duration_seconds: u32,
    pub commission_id: Option<String>,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ContributorReputation {
    pub address: Address,
    pub reputation_score: u32,
    pub datasets_registered: u32,
    pub total_royalties_stroops: i128,
    pub quality_average: u32,
}

// Returns true when every byte of the proposed metadata hash is zero.
// An all-zero BytesN<32> is not a valid content hash — it indicates a
// missing or uncalculated SHA-256/BLAKE3 digest and would corrupt provenance.
pub(crate) fn hash_bytes_are_zero(bytes: &[u8; 32]) -> bool {
    *bytes == [0u8; 32]
}

#[contract]
pub struct DatasetRegistry;

#[contractimpl]
impl DatasetRegistry {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&symbol_short!("admin")) {
            panic!("already initialized");
        }
        admin.require_auth();
        env.storage().instance().set(&symbol_short!("admin"), &admin);
        env.storage().instance().set(&symbol_short!("count"), &0u32);
    }

    pub fn register_dataset(
        env: Env,
        owner: Address,
        language_code: String,
        name: String,
        metadata_hash: soroban_sdk::BytesN<32>,
        contributors: Vec<ContributorShare>,
        sample_count: u32,
        duration_seconds: u32,
        commission_id: Option<String>,
    ) -> String {
        owner.require_auth();

        // Reject an all-zero hash before storing: it signals a placeholder that
        // was never replaced with the actual content digest, creating invalid
        // provenance records on-chain.
        if hash_bytes_are_zero(&metadata_hash.to_array()) {
            panic!("metadata_hash must be non-zero");
        }

        let total: u32 = contributors.iter().map(|c| c.share_bps).sum();
        if total != 10000 {
            panic!("contributor shares must sum to 10000 bps");
        }

        let count: u32 = env
            .storage()
            .instance()
            .get(&symbol_short!("count"))
            .unwrap_or(0);
        let id = String::from_str(&env, &format!("ds_{}", count + 1));

        let dataset = Dataset {
            id: id.clone(),
            owner: owner.clone(),
            language_code: language_code.clone(),
            name: name.clone(),
            metadata_hash,
            version: 1,
            state: DatasetState::Active,
            contributors,
            created_ledger: env.ledger().sequence(),
            sample_count,
            duration_seconds,
            commission_id,
        };

        env.storage().persistent().set(&id, &dataset);
        env.storage()
            .instance()
            .set(&symbol_short!("count"), &(count + 1));
        env.storage().persistent().extend_ttl(&id, 7_776_000, 7_776_000);

        Self::increment_reputation(&env, &owner);

        // Provenance event for off-chain indexers. Topic is
        // ("dataset", "registered"); the data is the full self-contained record.
        // "registered" exceeds the 9-char `symbol_short!` limit, so build it with
        // `Symbol::new`.
        env.events().publish(
            (symbol_short!("dataset"), Symbol::new(&env, "registered")),
            DatasetRegisteredEvent {
                id: dataset.id.clone(),
                owner: dataset.owner.clone(),
                language_code: dataset.language_code.clone(),
                name: dataset.name.clone(),
                metadata_hash: dataset.metadata_hash.clone(),
                version: dataset.version,
                sample_count: dataset.sample_count,
                duration_seconds: dataset.duration_seconds,
                commission_id: dataset.commission_id.clone(),
                created_ledger: dataset.created_ledger,
            },
        );

        id
    }

    fn increment_reputation(env: &Env, address: &Address) {
        let mut rep: ContributorReputation =
            env.storage()
                .persistent()
                .get(address)
                .unwrap_or(ContributorReputation {
                    address: address.clone(),
                    reputation_score: 0,
                    datasets_registered: 0,
                    total_royalties_stroops: 0,
                    quality_average: 0,
                });
        rep.datasets_registered += 1;
        rep.reputation_score = (rep.reputation_score + 50).min(1000);
        env.storage().persistent().set(address, &rep);
        env.storage()
            .persistent()
            .extend_ttl(address, 7_776_000, 7_776_000);
    }

    pub fn get_reputation(env: Env, address: Address) -> ContributorReputation {
        env.storage()
            .persistent()
            .get(&address)
            .expect("no reputation data")
    }

    pub fn get_dataset(env: Env, dataset_id: String) -> Dataset {
        env.storage()
            .persistent()
            .get(&dataset_id)
            .expect("dataset not found")
    }

    pub fn dataset_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&symbol_short!("count"))
            .unwrap_or(0)
    }

    pub fn version(_env: Env) -> u32 {
        3
    }
}

// Pure-Rust tests for the zero-hash guard — no soroban VM required.
// The soroban testutils feature is intentionally excluded from dev-dependencies
// to avoid a transitive rand_core/ed25519_dalek version conflict in
// soroban-env-host that prevents test compilation on current stable Rust.
// These tests verify the precise byte-level predicate that guards on-chain storage.
#[cfg(test)]
mod tests {
    use super::hash_bytes_are_zero;

    #[test]
    fn all_zero_is_detected() {
        assert!(hash_bytes_are_zero(&[0u8; 32]));
    }

    #[test]
    fn first_byte_nonzero_passes() {
        let mut b = [0u8; 32];
        b[0] = 0x01;
        assert!(!hash_bytes_are_zero(&b));
    }

    #[test]
    fn last_byte_nonzero_passes() {
        let mut b = [0u8; 32];
        b[31] = 0xff;
        assert!(!hash_bytes_are_zero(&b));
    }

    #[test]
    fn middle_byte_nonzero_passes() {
        let mut b = [0u8; 32];
        b[16] = 0xab;
        assert!(!hash_bytes_are_zero(&b));
    }

    #[test]
    fn realistic_sha256_hash_passes() {
        // SHA-256("lingualayer") — a representative non-zero hash
        let hash: [u8; 32] = [
            0x2a, 0x4c, 0x8e, 0xf1, 0xb3, 0x77, 0xd9, 0x05, 0x6f, 0x1a, 0x3b, 0xcc, 0x44, 0x8d,
            0x92, 0xe0, 0x71, 0x5f, 0x28, 0xa9, 0xde, 0x60, 0xb4, 0x37, 0x19, 0xfd, 0x82, 0x0c,
            0xe5, 0x11, 0x4a, 0x78,
        ];
        assert!(!hash_bytes_are_zero(&hash));
    }
}
