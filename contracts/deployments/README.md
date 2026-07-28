# Deployment output

`contracts/scripts/deploy.sh` writes a `<network>.env` file here with the
contract IDs from its most recent run, in both the `apps/backend` and
`apps/web` variable-naming conventions. These files aren't committed (each
run can produce different addresses) — copy the values you need into
`apps/backend/.env` / `apps/web/.env.local`, and update the contract address
table in the root `README.md` for anything meant to be the project's
long-lived deployment.
