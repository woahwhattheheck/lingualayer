#![cfg_attr(not(test), no_std)]
//! Shared emergency admin-handoff logic for LinguaLayer's contracts.
//!
//! Every contract that stores a single `admin: Address` has no recovery
//! path if that key is lost or compromised: `initialize` can only run once,
//! and nothing else can ever change `admin`. This crate adds two ways to
//! rotate it:
//!
//! - **Planned rotation** (`propose_admin` / `accept_admin`): the current
//!   admin proposes a successor, and that successor must independently
//!   authorize accepting the role. The two-step handshake means a typo'd or
//!   unreachable address can never brick admin control — nothing changes
//!   until the *new* admin proves they hold that key. This is how you'd
//!   rotate onto a fresh key, or upgrade `admin` to a proper multi-sig
//!   Stellar account, before anything is suspected of being compromised.
//! - **Emergency takeover** (`recovery_takeover`): a separate `recovery`
//!   address — set at `initialize` and intended to be an independently
//!   held (ideally multi-sig) account — can force `admin` to a new address
//!   immediately, without the current admin's cooperation at all. This is
//!   the actual answer to "the admin key is compromised": the compromised
//!   key is never needed to remove its own access.
//!
//! `recovery` is deliberately not the same address as `admin` (enforced at
//! `initialize` and `set_recovery`) — a recovery path that shares its
//! single point of failure with the thing it's meant to recover from isn't
//! one.

use soroban_sdk::{symbol_short, Address, Env, Symbol};

fn admin_key() -> Symbol {
    symbol_short!("admin")
}

fn pending_key() -> Symbol {
    symbol_short!("pending")
}

fn recovery_key() -> Symbol {
    symbol_short!("recovery")
}

/// One-time setup. Panics if already initialized, or if `recovery` and
/// `admin` are the same address. Requires `admin`'s authorization.
pub fn init(env: &Env, admin: &Address, recovery: &Address) {
    if env.storage().instance().has(&admin_key()) {
        panic!("already initialized");
    }
    if admin == recovery {
        panic!("recovery must differ from admin");
    }
    admin.require_auth();
    env.storage().instance().set(&admin_key(), admin);
    env.storage().instance().set(&recovery_key(), recovery);
}

/// Returns the current admin. Panics if not initialized.
pub fn admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&admin_key())
        .expect("not initialized")
}

/// Returns the current recovery address. Panics if not initialized.
pub fn recovery(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&recovery_key())
        .expect("not initialized")
}

/// Returns the address of a pending admin proposal, if any.
pub fn pending_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&pending_key())
}

/// Panics unless the caller is the current admin, then panics unless
/// `caller.require_auth()` succeeds. Contracts call this to gate their own
/// admin-only functions with the same admin this crate manages.
pub fn require_admin(env: &Env, caller: &Address) {
    let stored = admin(env);
    if caller != &stored {
        panic!("unauthorized");
    }
    caller.require_auth();
}

/// Current admin proposes `new_admin`. Requires the current admin's
/// authorization. Does not take effect until `accept_admin` is called by
/// `new_admin` itself.
pub fn propose_admin(env: &Env, new_admin: &Address) {
    let current = admin(env);
    current.require_auth();
    env.storage().instance().set(&pending_key(), new_admin);
    env.events()
        .publish((admin_key(), symbol_short!("proposed")), new_admin.clone());
}

/// The pending admin accepts the role, becoming the new admin. Requires the
/// pending admin's own authorization — proving they control that address —
/// and clears the pending proposal. Panics if there is no pending proposal.
pub fn accept_admin(env: &Env) -> Address {
    let pending: Address = env
        .storage()
        .instance()
        .get(&pending_key())
        .expect("no pending admin transfer");
    pending.require_auth();
    env.storage().instance().set(&admin_key(), &pending);
    env.storage().instance().remove(&pending_key());
    env.events()
        .publish((admin_key(), symbol_short!("accepted")), pending.clone());
    pending
}

/// The recovery address forces `admin` to `new_admin` immediately, without
/// any cooperation from the current (possibly compromised) admin. Clears
/// any pending proposal so a stale `accept_admin` can't hijack the
/// newly-recovered admin. Requires the recovery address's authorization.
pub fn recovery_takeover(env: &Env, new_admin: &Address) {
    let guardian = recovery(env);
    guardian.require_auth();
    env.storage().instance().remove(&pending_key());
    env.storage().instance().set(&admin_key(), new_admin);
    env.events()
        .publish((admin_key(), symbol_short!("takeover")), new_admin.clone());
}

/// Current admin rotates the recovery address. Requires the current admin's
/// authorization. Panics if `new_recovery` equals the current admin.
pub fn set_recovery(env: &Env, new_recovery: &Address) {
    let current = admin(env);
    current.require_auth();
    if &current == new_recovery {
        panic!("recovery must differ from admin");
    }
    env.storage().instance().set(&recovery_key(), new_recovery);
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{contract, contractimpl, testutils::Address as _};

    // A minimal host contract purely so these free functions have a real
    // storage/auth context to run against (Soroban ties both to the
    // currently-executing contract frame).
    #[contract]
    struct Harness;

    #[contractimpl]
    impl Harness {
        pub fn initialize(env: Env, admin: Address, recovery: Address) {
            init(&env, &admin, &recovery);
        }
        pub fn propose_admin(env: Env, new_admin: Address) {
            propose_admin(&env, &new_admin);
        }
        pub fn accept_admin(env: Env) -> Address {
            accept_admin(&env)
        }
        pub fn recovery_takeover(env: Env, new_admin: Address) {
            recovery_takeover(&env, &new_admin);
        }
        pub fn set_recovery(env: Env, new_recovery: Address) {
            set_recovery(&env, &new_recovery);
        }
        pub fn admin(env: Env) -> Address {
            admin(&env)
        }
        pub fn recovery(env: Env) -> Address {
            recovery(&env)
        }
        pub fn pending_admin(env: Env) -> Option<Address> {
            pending_admin(&env)
        }
        pub fn guarded(env: Env, caller: Address) {
            require_admin(&env, &caller);
        }
    }

    fn setup(env: &Env) -> (HarnessClient<'_>, Address, Address) {
        env.mock_all_auths();
        let id = env.register(Harness, ());
        let client = HarnessClient::new(env, &id);
        let admin = Address::generate(env);
        let recovery = Address::generate(env);
        client.initialize(&admin, &recovery);
        (client, admin, recovery)
    }

    #[test]
    #[should_panic(expected = "recovery must differ from admin")]
    fn init_rejects_recovery_equal_to_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(Harness, ());
        let client = HarnessClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin, &admin);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn init_rejects_double_initialize() {
        let env = Env::default();
        let (client, admin, recovery) = setup(&env);
        client.initialize(&admin, &recovery);
    }

    #[test]
    fn propose_then_accept_transfers_admin() {
        let env = Env::default();
        let (client, admin, _recovery) = setup(&env);
        let successor = Address::generate(&env);

        client.propose_admin(&successor);
        assert_eq!(client.pending_admin(), Some(successor.clone()));

        let accepted = client.accept_admin();
        assert_eq!(accepted, successor);
        assert_eq!(client.admin(), successor);
        assert_eq!(client.pending_admin(), None);
        let _ = admin; // old admin is no longer relevant after transfer
    }

    #[test]
    #[should_panic(expected = "no pending admin transfer")]
    fn accept_without_proposal_panics() {
        let env = Env::default();
        let (client, _admin, _recovery) = setup(&env);
        client.accept_admin();
    }

    #[test]
    fn recovery_takeover_bypasses_current_admin() {
        let env = Env::default();
        let (client, _admin, _recovery) = setup(&env);
        let rescuer = Address::generate(&env);

        client.recovery_takeover(&rescuer);
        assert_eq!(client.admin(), rescuer);
    }

    #[test]
    fn recovery_takeover_clears_stale_pending_proposal() {
        let env = Env::default();
        let (client, _admin, _recovery) = setup(&env);
        let stale_pending = Address::generate(&env);
        let rescuer = Address::generate(&env);

        client.propose_admin(&stale_pending);
        client.recovery_takeover(&rescuer);

        assert_eq!(client.admin(), rescuer);
        assert_eq!(client.pending_admin(), None);
    }

    #[test]
    fn admin_can_rotate_recovery() {
        let env = Env::default();
        let (client, _admin, recovery) = setup(&env);
        let new_recovery = Address::generate(&env);

        client.set_recovery(&new_recovery);
        assert_eq!(client.recovery(), new_recovery);
        let _ = recovery;
    }

    #[test]
    #[should_panic(expected = "recovery must differ from admin")]
    fn set_recovery_rejects_equal_to_admin() {
        let env = Env::default();
        let (client, admin, _recovery) = setup(&env);
        client.set_recovery(&admin);
    }

    #[test]
    fn require_admin_allows_current_admin() {
        let env = Env::default();
        let (client, admin, _recovery) = setup(&env);
        client.guarded(&admin); // must not panic
    }

    #[test]
    #[should_panic(expected = "unauthorized")]
    fn require_admin_rejects_non_admin() {
        let env = Env::default();
        let (client, _admin, _recovery) = setup(&env);
        let impostor = Address::generate(&env);
        client.guarded(&impostor);
    }
}
