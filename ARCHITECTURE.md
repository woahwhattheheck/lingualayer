# LinguaLayer Architecture

This document describes how the five Soroban smart contracts that make up LinguaLayer interact. It is aimed at contributors who want to understand the system before diving into individual contracts.

---

## Overview

LinguaLayer is a decentralised marketplace for language audio datasets. Five contracts collaborate to cover the full lifecycle: commissioning a dataset, registering it on-chain, attesting to its quality, routing licences, and distributing royalties to contributors.

```
┌────────────────────────────────────────────────────────────────┐
│  Buyer / Commissioner                                          │
│         │  post_commission()                                   │
│         ▼                                                      │
│  ┌──────────────────┐   fulfil_commission()  ┌─────────────┐  │
│  │  DataCommission  │ ──────────────────────▶│  (bounty    │  │
│  │  (escrow bounty) │                        │   payout)   │  │
│  └──────────────────┘                        └─────────────┘  │
│         ▲ commission_id                                        │
│         │                                                      │
│  ┌──────────────────┐   dataset_id   ┌──────────────────────┐ │
│  │  DatasetRegistry │ ◀────────────  │  Contributor         │ │
│  │  (metadata +     │                │  register_dataset()  │ │
│  │   contributor    │                └──────────────────────┘ │
│  │   shares)        │                                         │
│  └──────────────────┘                                         │
│         │  dataset_id                                         │
│         ▼                                                      │
│  ┌──────────────────┐                                         │
│  │  QualityOracle   │  royalty_multiplier_bps(dataset_id)     │
│  │  (curator scores │ ──────────────────────────────────────▶ │
│  │   → tier)        │          ┌──────────────────────────┐   │
│  └──────────────────┘          │  LicenseRouter           │   │
│                                │  (routes licence fees)   │   │
│                                └──────────────┬───────────┘   │
│                                               │ fee amount     │
│                                               ▼               │
│                                ┌──────────────────────────┐   │
│                                │  RoyaltySplitter         │   │
│                                │  (distributes per bps    │   │
│                                │   shares in Dataset)     │   │
│                                └──────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

---

## Contract Descriptions

### 1. DataCommission (`contracts/data-commission`)

**Purpose:** Lets data buyers post bounties for specific language datasets.

A *commissioner* calls `post_commission()` with a bounty amount in a Stellar token. The contract holds the tokens in escrow. When a matching dataset is registered and approved, the admin calls `fulfil_commission()`, which transfers the bounty to the fulfiller and links the commission to the dataset via `fulfilled_dataset_id`.

Key state stored per commission:
- `language_code`, `description_hash`, `min_sample_count`, `min_duration_seconds`, `deadline_ledger` — acceptance criteria
- `bounty_token` / `bounty_amount` — escrowed reward
- `state` — `Open` → `Fulfilled` or `Cancelled`

**Outbound link:** the `commission_id` produced here is passed into `DatasetRegistry.register_dataset()` so the two records are permanently linked on-chain.

---

### 2. DatasetRegistry (`contracts/dataset-registry`)

**Purpose:** The canonical registry for language audio datasets and their contributors.

A contributor calls `register_dataset()` to publish a dataset on-chain. They must provide:
- `contributors: Vec<ContributorShare>` — each entry is an address + `share_bps` (basis points). The shares **must sum to exactly 10 000** (100 %).
- An optional `commission_id` — links this dataset to an open `DataCommission`.

Each successful registration increments the owner's **reputation score** (capped at 1 000) stored in `ContributorReputation`.

**Inbound link from DataCommission:** the `commission_id` field ties a dataset to the bounty that motivated it.

**Outbound links:**
- `QualityOracle` reads `dataset_id` strings produced here when curators attest quality.
- `RoyaltySplitter` reads the `contributors` array from this registry to know how to split royalties.

---

### 3. QualityOracle (`contracts/quality-oracle`)

**Purpose:** Provides an on-chain quality signal for datasets, consumed by the royalty pipeline.

Curators self-register with `register_curator()` and then call `attest_quality(dataset_id, score, rubric_hash)` (score 0–100). The contract aggregates all attestations into a running `average_score` and maps that to a **quality tier**:

| Average score | Tier     | Royalty multiplier |
|---------------|----------|--------------------|
| 0             | Unrated  | 1.00× (10 000 bps) |
| 1–39          | Bronze   | 0.75× ( 7 500 bps) |
| 40–69         | Silver   | 1.00× (10 000 bps) |
| 70–84         | Gold     | 1.25× (12 500 bps) |
| 85–100        | Platinum | 1.50× (15 000 bps) |

`royalty_multiplier_bps(dataset_id)` is the key integration surface — `LicenseRouter` calls this to scale licence fees before routing them to `RoyaltySplitter`.

---

### 4. LicenseRouter (`contracts/license-router`)

**Purpose:** Routes licence fees from buyers to the royalty pipeline, applying quality-tier scaling.

Currently a scaffold. The intended production behaviour:

1. Receive a licence payment for a `dataset_id`.
2. Call `QualityOracle.royalty_multiplier_bps(dataset_id)` to get the tier multiplier.
3. Compute `adjusted_fee = raw_fee * multiplier / 10_000`.
4. Forward `adjusted_fee` to `RoyaltySplitter` along with the `dataset_id`.

---

### 5. RoyaltySplitter (`contracts/royalty-splitter`)

**Purpose:** Distributes a licence fee payment proportionally among dataset contributors.

Currently a scaffold. The intended production behaviour:

1. Receive the adjusted fee from `LicenseRouter` plus the `dataset_id`.
2. Call `DatasetRegistry.get_dataset(dataset_id)` to fetch the `contributors` array.
3. For each `ContributorShare`, transfer `fee * share_bps / 10_000` to the contributor's address.

Because shares in `DatasetRegistry` are guaranteed to sum to 10 000 bps, the full fee is always distributed with no remainder.

---

## End-to-End Lifecycle

```
1. COMMISSION
   Buyer ──► DataCommission.post_commission()
             Bounty tokens locked in escrow.

2. DATASET REGISTRATION
   Contributor ──► DatasetRegistry.register_dataset(commission_id=...)
                   Dataset ID minted; reputation score updated.

3. COMMISSION FULFILMENT
   Admin ──► DataCommission.fulfil_commission(commission_id, fulfiller, dataset_id)
             Escrow released to fulfiller.

4. QUALITY ATTESTATION
   Curator ──► QualityOracle.register_curator()
   Curator ──► QualityOracle.attest_quality(dataset_id, score, rubric_hash)
               Running average and tier updated.

5. LICENSING
   Buyer ──► LicenseRouter (pays fee for dataset_id)
             ├─ QualityOracle.royalty_multiplier_bps(dataset_id)  [read]
             └─► RoyaltySplitter (adjusted fee, dataset_id)
                 └─ DatasetRegistry.get_dataset(dataset_id)       [read]
                    Split to each ContributorShare.address
```

---

## Storage Layout

| Contract | Key pattern | Value type | Storage tier |
|---|---|---|---|
| DataCommission | `"com_{n}"` | `Commission` | Persistent |
| DataCommission | `"com_cnt"` (symbol) | `u32` | Instance |
| DatasetRegistry | `"ds_{n}"` | `Dataset` | Persistent |
| DatasetRegistry | `"rep_{address}"` | `ContributorReputation` | Persistent |
| DatasetRegistry | `"count"` (symbol) | `u32` | Instance |
| QualityOracle | `"att_{dataset_id}_{curator}"` | `QualityAttestation` | Persistent |
| QualityOracle | `"agg_{dataset_id}"` | `DatasetQuality` | Persistent |
| QualityOracle | `"cur_{address}"` | `bool` | Persistent |
| QualityOracle | `"cur_cnt"` (symbol) | `u32` | Instance |

LicenseRouter and RoyaltySplitter are scaffolds and currently store only an `admin` symbol in instance storage.

All persistent entries use a TTL bump of **7 776 000 ledgers** (~90 days on Stellar) on write.

---

## Deployment Order

`QualityOracle` must be deployed before `LicenseRouter`, which binds to its address at init time (and needs its compiled wasm on disk at *build* time — see `license-router`'s `contractimport!`). `DatasetRegistry`, `DataCommission`, and `QualityOracle` have no init-time dependencies on each other. `RoyaltySplitter` is still a scaffold and doesn't take a real admin yet.

Recommended order:

```
1. QualityOracle.initialize(admin, recovery, min_stake)
2. DatasetRegistry.initialize(admin, recovery)
3. DataCommission.initialize(admin, recovery)
4. RoyaltySplitter.initialize(admin)          — scaffold; admin is a Symbol, not an Address
5. LicenseRouter.initialize(admin, recovery, oracle=quality_oracle_addr)
```

## Admin & Emergency Recovery

`DatasetRegistry`, `DataCommission`, `QualityOracle`, and `LicenseRouter` all take a second `recovery: Address` at `initialize` (required to differ from `admin`), backed by the shared `contracts/access-control` crate:

- **Planned rotation** — `propose_admin(new_admin)` (current admin only) followed by `accept_admin()` (must be called by `new_admin` itself). Nothing changes until the successor proves they hold that key, so a typo'd or unreachable address can never brick admin control. Use this to rotate onto a fresh key, or to upgrade `admin` to a proper multi-sig Stellar account, before anything is suspected of being compromised.
- **Emergency takeover** — `recovery_takeover(new_admin)`, callable only by the `recovery` address, forces `admin` to `new_admin` immediately with zero cooperation from the current admin. This is the answer to "the admin key is compromised": the compromised key is never needed to remove its own access. `recovery` itself can be rotated via `set_recovery` (current admin only).

`RoyaltySplitter` is excluded — its `admin` is a placeholder `Symbol` with no gated behavior yet, not a real access-control root.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branch, commit, and PR conventions. When touching a contract, run the full test suite from the repo root:

```bash
cargo test --workspace
```
