#![cfg_attr(not(test), no_std)]
extern crate alloc;

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token,
    Address, Env, String, Vec,
};

// Commissions whose bounty_amount exceeds this threshold (in token base units)
// must use milestone-based escrow before the fulfiller receives any payment.
// 1 000 USDC = 1_000 * 10^7 = 10_000_000_000 stroops (Stellar USDC has 7 decimals).
pub const MILESTONE_THRESHOLD: i128 = 10_000_000_000;

// ── State types ──────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommissionState {
    Open,
    Fulfilled,
    Cancelled,
    Expired,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MilestoneState {
    Pending,
    Released,
}

// ── Core structs ─────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct Milestone {
    pub description_hash: soroban_sdk::BytesN<32>,
    pub amount: i128,
    pub state: MilestoneState,
}

/// Milestones are stored inline with the commission to avoid needing
/// a derived string key (soroban_sdk::String has no Display/format support
/// in #![no_std] contexts without careful alloc wiring).
#[contracttype]
#[derive(Clone, Debug)]
pub struct Commission {
    pub id: String,
    pub commissioner: Address,
    pub language_code: String,
    pub description_hash: soroban_sdk::BytesN<32>,
    pub bounty_token: Address,
    pub bounty_amount: i128,
    pub min_sample_count: u32,
    pub min_duration_seconds: u32,
    pub deadline_ledger: u32,
    pub state: CommissionState,
    pub fulfiller: Option<Address>,
    pub fulfilled_dataset_id: Option<String>,
    /// When set, payment is gated behind per-milestone approvals.
    pub milestones: Option<Vec<Milestone>>,
    /// Total amount already paid out through approved milestones.
    pub released_amount: i128,
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct DataCommission;

#[contractimpl]
impl DataCommission {
    /// `recovery` is a separate address that can force an admin handoff via
    /// `recovery_takeover` without the current admin's cooperation — see
    /// the `access-control` crate's docs for why this exists and why it
    /// must differ from `admin`.
    pub fn initialize(env: Env, admin: Address, recovery: Address) {
        access_control::init(&env, &admin, &recovery);
        env.storage().instance().set(&symbol_short!("com_cnt"), &0u32);
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

    pub fn post_commission(
        env: Env,
        commissioner: Address,
        language_code: String,
        description_hash: soroban_sdk::BytesN<32>,
        bounty_token: Address,
        bounty_amount: i128,
        min_sample_count: u32,
        min_duration_seconds: u32,
        deadline_ledger: u32,
    ) -> String {
        commissioner.require_auth();
        if bounty_amount <= 0 {
            panic!("bounty must be positive");
        }
        if deadline_ledger <= env.ledger().sequence() {
            panic!("deadline must be in the future");
        }

        let tok = token::Client::new(&env, &bounty_token);
        tok.transfer(&commissioner, &env.current_contract_address(), &bounty_amount);

        let cnt: u32 = env
            .storage()
            .instance()
            .get(&symbol_short!("com_cnt"))
            .unwrap_or(0);
        let id = String::from_str(&env, &alloc::format!("com_{}", cnt + 1));

        let commission = Commission {
            id: id.clone(),
            commissioner,
            language_code,
            description_hash,
            bounty_token,
            bounty_amount,
            min_sample_count,
            min_duration_seconds,
            deadline_ledger,
            state: CommissionState::Open,
            fulfiller: None,
            fulfilled_dataset_id: None,
            milestones: None,
            released_amount: 0,
        };

        env.storage().persistent().set(&id, &commission);
        env.storage().persistent().extend_ttl(&id, 7_776_000, 7_776_000);
        env.storage().instance().set(&symbol_short!("com_cnt"), &(cnt + 1));

        id
    }

    /// Define milestones for a large commission.
    ///
    /// - Callable only by the commissioner.
    /// - Requires `bounty_amount > MILESTONE_THRESHOLD`.
    /// - Milestone amounts must sum exactly to `bounty_amount`.
    /// - Can only be called once while the commission is `Open` and no
    ///   fulfiller has been assigned yet.
    pub fn create_milestones(env: Env, commission_id: String, milestones: Vec<Milestone>) {
        let mut comm: Commission = env
            .storage()
            .persistent()
            .get(&commission_id)
            .expect("commission not found");

        comm.commissioner.require_auth();

        if comm.state != CommissionState::Open {
            panic!("commission not open");
        }
        if comm.milestones.is_some() {
            panic!("milestones already set");
        }
        if comm.fulfiller.is_some() {
            panic!("fulfiller already assigned");
        }
        if comm.bounty_amount <= MILESTONE_THRESHOLD {
            panic!("milestones only allowed for commissions above threshold");
        }
        if milestones.is_empty() {
            panic!("must provide at least one milestone");
        }

        let total: i128 = milestones.iter().map(|m| m.amount).sum();
        if total != comm.bounty_amount {
            panic!("milestone amounts must sum to bounty amount");
        }
        for m in milestones.iter() {
            if m.amount <= 0 {
                panic!("each milestone amount must be positive");
            }
            if m.state != MilestoneState::Pending {
                panic!("new milestones must start as Pending");
            }
        }

        comm.milestones = Some(milestones);
        env.storage().persistent().set(&commission_id, &comm);
    }

    /// Admin approves and releases a single milestone payment to the fulfiller.
    ///
    /// - The commission must be `Open` with a fulfiller already assigned.
    /// - When the last pending milestone is released the commission
    ///   transitions to `Fulfilled`.
    pub fn approve_milestone(env: Env, commission_id: String, milestone_index: u32) {
        let admin = access_control::admin(&env);
        admin.require_auth();

        let mut comm: Commission = env
            .storage()
            .persistent()
            .get(&commission_id)
            .expect("commission not found");

        if comm.state != CommissionState::Open {
            panic!("commission not open");
        }
        let fulfiller = comm.fulfiller.clone().expect("no fulfiller assigned yet");
        let mut milestones = comm.milestones.clone().expect("commission has no milestones");

        if milestone_index >= milestones.len() {
            panic!("invalid milestone index");
        }

        let mut ms = milestones.get(milestone_index).unwrap();
        if ms.state != MilestoneState::Pending {
            panic!("milestone already released");
        }

        let tok = token::Client::new(&env, &comm.bounty_token);
        tok.transfer(&env.current_contract_address(), &fulfiller, &ms.amount);

        comm.released_amount += ms.amount;
        ms.state = MilestoneState::Released;
        milestones.set(milestone_index, ms);

        let all_released = milestones.iter().all(|m| m.state == MilestoneState::Released);
        if all_released {
            comm.state = CommissionState::Fulfilled;
        }

        comm.milestones = Some(milestones);
        env.storage().persistent().set(&commission_id, &comm);
    }

    /// Admin marks the commission fulfilled and records the fulfiller/dataset.
    ///
    /// For **non-milestone** commissions the full bounty is transferred here.
    /// For **milestone** commissions no funds move here — they flow through
    /// `approve_milestone` instead. The commission stays `Open` so subsequent
    /// milestone approvals remain possible.
    pub fn fulfil_commission(
        env: Env,
        commission_id: String,
        fulfiller: Address,
        dataset_id: String,
    ) {
        let admin = access_control::admin(&env);
        admin.require_auth();

        let mut comm: Commission = env
            .storage()
            .persistent()
            .get(&commission_id)
            .expect("commission not found");

        if comm.state != CommissionState::Open {
            panic!("commission not open");
        }

        if comm.milestones.is_some() {
            // Just record the fulfiller; payment flows via approve_milestone.
            comm.fulfiller = Some(fulfiller);
            comm.fulfilled_dataset_id = Some(dataset_id);
            env.storage().persistent().set(&commission_id, &comm);
        } else {
            let tok = token::Client::new(&env, &comm.bounty_token);
            tok.transfer(&env.current_contract_address(), &fulfiller, &comm.bounty_amount);
            comm.state = CommissionState::Fulfilled;
            comm.fulfiller = Some(fulfiller);
            comm.fulfilled_dataset_id = Some(dataset_id);
            env.storage().persistent().set(&commission_id, &comm);
        }
    }

    /// Cancel an open commission and refund the escrowed balance.
    ///
    /// - Before the deadline the commissioner must authorise the call.
    /// - After the deadline anyone can trigger the refund.
    /// - For milestone commissions only the **unreleased** amount is refunded.
    pub fn cancel_commission(env: Env, commission_id: String) {
        let mut comm: Commission = env
            .storage()
            .persistent()
            .get(&commission_id)
            .expect("commission not found");

        if comm.state != CommissionState::Open {
            panic!("commission not open");
        }
        if env.ledger().sequence() <= comm.deadline_ledger {
            comm.commissioner.require_auth();
        }

        let refund_amount = comm.bounty_amount - comm.released_amount;
        if refund_amount > 0 {
            let tok = token::Client::new(&env, &comm.bounty_token);
            tok.transfer(&env.current_contract_address(), &comm.commissioner, &refund_amount);
        }

        comm.state = CommissionState::Cancelled;
        env.storage().persistent().set(&commission_id, &comm);
    }

    /// Return the milestones for a commission.
    pub fn get_milestones(env: Env, commission_id: String) -> Vec<Milestone> {
        let comm: Commission = env
            .storage()
            .persistent()
            .get(&commission_id)
            .expect("commission not found");
        comm.milestones.expect("no milestones for this commission")
    }

    pub fn get_commission(env: Env, commission_id: String) -> Commission {
        env.storage()
            .persistent()
            .get(&commission_id)
            .expect("commission not found")
    }

    pub fn version(_env: Env) -> u32 {
        3
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger, LedgerInfo},
        BytesN, Env,
    };

    fn setup() -> (Env, DataCommissionClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, DataCommission);
        let client = DataCommissionClient::new(&env, &id);
        (env, client)
    }

    fn hash(env: &Env, seed: u8) -> BytesN<32> {
        BytesN::from_array(env, &{
            let mut b = [0u8; 32];
            b[0] = seed;
            b
        })
    }

    fn mint_token(env: &Env, admin: &Address, to: &Address, amount: i128) -> Address {
        let id = env.register_stellar_asset_contract_v2(admin.clone());
        let addr = id.address();
        soroban_sdk::token::StellarAssetClient::new(env, &addr).mint(to, &amount);
        addr
    }

    fn future(env: &Env, delta: u32) -> u32 {
        env.ledger().sequence() + delta
    }

    // ── small commission: non-milestone path unchanged ─────────────────────

    #[test]
    fn small_commission_pays_out_on_fulfil() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let commissioner = Address::generate(&env);
        let fulfiller = Address::generate(&env);
        let amount: i128 = 5_000_000_000; // 500 USDC
        let token = mint_token(&env, &admin, &commissioner, amount);

        let recovery = Address::generate(&env);
        client.initialize(&admin, &recovery);
        let com_id = client.post_commission(
            &commissioner,
            &String::from_str(&env, "en"),
            &hash(&env, 1),
            &token,
            &amount,
            &10,
            &3600,
            &future(&env, 100),
        );

        client.fulfil_commission(&com_id, &fulfiller, &String::from_str(&env, "ds_1"));

        let comm = client.get_commission(&com_id);
        assert_eq!(comm.state, CommissionState::Fulfilled);
        assert!(comm.milestones.is_none());
        assert_eq!(token::Client::new(&env, &token).balance(&fulfiller), amount);
    }

    // ── create_milestones rejected below threshold ─────────────────────────

    #[test]
    #[should_panic(expected = "milestones only allowed for commissions above threshold")]
    fn milestones_rejected_below_threshold() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let commissioner = Address::generate(&env);
        let amount: i128 = 5_000_000_000;
        let token = mint_token(&env, &admin, &commissioner, amount);

        let recovery = Address::generate(&env);
        client.initialize(&admin, &recovery);
        let com_id = client.post_commission(
            &commissioner,
            &String::from_str(&env, "fr"),
            &hash(&env, 2),
            &token,
            &amount,
            &5,
            &1800,
            &future(&env, 50),
        );
        client.create_milestones(
            &com_id,
            &Vec::from_array(
                &env,
                [Milestone {
                    description_hash: hash(&env, 10),
                    amount,
                    state: MilestoneState::Pending,
                }],
            ),
        );
    }

    // ── large commission: full milestone happy path ────────────────────────

    #[test]
    fn large_commission_milestone_full_flow() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let commissioner = Address::generate(&env);
        let fulfiller = Address::generate(&env);
        let total: i128 = 20_000_000_000; // 2 000 USDC
        let token = mint_token(&env, &admin, &commissioner, total);

        let recovery = Address::generate(&env);
        client.initialize(&admin, &recovery);
        let com_id = client.post_commission(
            &commissioner,
            &String::from_str(&env, "de"),
            &hash(&env, 3),
            &token,
            &total,
            &50,
            &7200,
            &future(&env, 200),
        );

        let (m1, m2, m3): (i128, i128, i128) = (5_000_000_000, 7_000_000_000, 8_000_000_000);
        client.create_milestones(
            &com_id,
            &Vec::from_array(
                &env,
                [
                    Milestone { description_hash: hash(&env, 11), amount: m1, state: MilestoneState::Pending },
                    Milestone { description_hash: hash(&env, 12), amount: m2, state: MilestoneState::Pending },
                    Milestone { description_hash: hash(&env, 13), amount: m3, state: MilestoneState::Pending },
                ],
            ),
        );

        assert!(client.get_commission(&com_id).milestones.is_some());

        // Assign fulfiller — no funds move yet
        client.fulfil_commission(&com_id, &fulfiller, &String::from_str(&env, "ds_2"));
        assert_eq!(client.get_commission(&com_id).state, CommissionState::Open);
        assert_eq!(token::Client::new(&env, &token).balance(&fulfiller), 0);

        // Release milestones one by one
        client.approve_milestone(&com_id, &0);
        assert_eq!(token::Client::new(&env, &token).balance(&fulfiller), m1);
        assert_eq!(client.get_commission(&com_id).state, CommissionState::Open);

        client.approve_milestone(&com_id, &1);
        assert_eq!(token::Client::new(&env, &token).balance(&fulfiller), m1 + m2);

        // Last milestone flips state to Fulfilled
        client.approve_milestone(&com_id, &2);
        assert_eq!(token::Client::new(&env, &token).balance(&fulfiller), total);
        assert_eq!(client.get_commission(&com_id).state, CommissionState::Fulfilled);
    }

    // ── cancel after partial milestone release ─────────────────────────────

    #[test]
    fn cancel_after_partial_release_refunds_remainder() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let commissioner = Address::generate(&env);
        let fulfiller = Address::generate(&env);
        let total: i128 = 20_000_000_000;
        let token = mint_token(&env, &admin, &commissioner, total);

        let recovery = Address::generate(&env);
        client.initialize(&admin, &recovery);
        let deadline = future(&env, 300);
        let com_id = client.post_commission(
            &commissioner,
            &String::from_str(&env, "ja"),
            &hash(&env, 5),
            &token,
            &total,
            &20,
            &3600,
            &deadline,
        );

        let half = total / 2;
        client.create_milestones(
            &com_id,
            &Vec::from_array(
                &env,
                [
                    Milestone { description_hash: hash(&env, 20), amount: half, state: MilestoneState::Pending },
                    Milestone { description_hash: hash(&env, 21), amount: half, state: MilestoneState::Pending },
                ],
            ),
        );
        client.fulfil_commission(&com_id, &fulfiller, &String::from_str(&env, "ds_3"));
        client.approve_milestone(&com_id, &0);

        // Advance past deadline so anyone can cancel. Keep every other field
        // (notably `protocol_version`) as the host already has them — the SDK
        // rejects moving `protocol_version` backwards, so a hardcoded value
        // here would go stale as soon as the SDK's default outpaces it.
        let mut ledger_info = env.ledger().get();
        ledger_info.sequence_number = deadline + 1;
        env.ledger().set(ledger_info);

        client.cancel_commission(&com_id);

        // Only the unreleased half is refunded
        assert_eq!(token::Client::new(&env, &token).balance(&commissioner), half);
        assert_eq!(client.get_commission(&com_id).state, CommissionState::Cancelled);
    }

    // ── double-approve guard ───────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "milestone already released")]
    fn double_approve_panics() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let commissioner = Address::generate(&env);
        let fulfiller = Address::generate(&env);
        let total: i128 = 20_000_000_000;
        let token = mint_token(&env, &admin, &commissioner, total);

        let recovery = Address::generate(&env);
        client.initialize(&admin, &recovery);
        let com_id = client.post_commission(
            &commissioner,
            &String::from_str(&env, "ko"),
            &hash(&env, 6),
            &token,
            &total,
            &10,
            &1800,
            &future(&env, 100),
        );
        // Two milestones so the commission stays Open after approving index 0,
        // which lets us attempt a duplicate approval while still Open.
        let half = total / 2;
        client.create_milestones(
            &com_id,
            &Vec::from_array(
                &env,
                [
                    Milestone {
                        description_hash: hash(&env, 30),
                        amount: half,
                        state: MilestoneState::Pending,
                    },
                    Milestone {
                        description_hash: hash(&env, 31),
                        amount: half,
                        state: MilestoneState::Pending,
                    },
                ],
            ),
        );
        client.fulfil_commission(&com_id, &fulfiller, &String::from_str(&env, "ds_4"));
        client.approve_milestone(&com_id, &0);
        client.approve_milestone(&com_id, &0); // already Released — should panic
    }

    // ── milestone sum mismatch guard ───────────────────────────────────────

    #[test]
    #[should_panic(expected = "milestone amounts must sum to bounty amount")]
    fn milestone_sum_mismatch_panics() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let commissioner = Address::generate(&env);
        let total: i128 = 20_000_000_000;
        let token = mint_token(&env, &admin, &commissioner, total);

        let recovery = Address::generate(&env);
        client.initialize(&admin, &recovery);
        let com_id = client.post_commission(
            &commissioner,
            &String::from_str(&env, "zh"),
            &hash(&env, 7),
            &token,
            &total,
            &10,
            &1800,
            &future(&env, 100),
        );
        client.create_milestones(
            &com_id,
            &Vec::from_array(
                &env,
                [Milestone {
                    description_hash: hash(&env, 40),
                    amount: total / 2, // doesn't sum to full amount
                    state: MilestoneState::Pending,
                }],
            ),
        );
    }
}

// ── Admin handoff ────────────────────────────────────────────────────────────

#[cfg(test)]
mod access_control_tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn setup() -> (Env, DataCommissionClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(DataCommission, ());
        let client = DataCommissionClient::new(&env, &id);
        let admin = Address::generate(&env);
        let recovery = Address::generate(&env);
        client.initialize(&admin, &recovery);
        (env, client, admin, recovery)
    }

    #[test]
    fn recovery_takeover_bypasses_current_admin() {
        let (_env, client, _admin, _recovery) = setup();
        let rescuer = Address::generate(&_env);
        client.recovery_takeover(&rescuer);
        assert_eq!(client.admin(), rescuer);
    }

    /// After a full propose/accept handoff, admin-gated calls (which read the
    /// current admin internally rather than taking it as a parameter) must
    /// still authorize correctly against the *new* admin.
    #[test]
    fn fulfil_commission_still_works_after_admin_rotation() {
        let (env, client, admin, _recovery) = setup();
        let commissioner = Address::generate(&env);
        let fulfiller = Address::generate(&env);
        let amount: i128 = 1_000_000_000;
        let token_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
        soroban_sdk::token::StellarAssetClient::new(&env, &token_id).mint(&commissioner, &amount);

        let com_id = client.post_commission(
            &commissioner,
            &String::from_str(&env, "am"),
            &soroban_sdk::BytesN::from_array(&env, &[9u8; 32]),
            &token_id,
            &amount,
            &10,
            &3600,
            &(env.ledger().sequence() + 100),
        );

        let new_admin = Address::generate(&env);
        client.propose_admin(&new_admin);
        client.accept_admin();
        assert_eq!(client.admin(), new_admin);

        client.fulfil_commission(&com_id, &fulfiller, &String::from_str(&env, "ds_am"));
        assert_eq!(client.get_commission(&com_id).state, CommissionState::Fulfilled);
    }
}
