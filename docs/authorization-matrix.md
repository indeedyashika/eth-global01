# Prism 8 API authorization matrix

`PUBLIC_READ` is read-only discovery/state. `AUTHENTICATED_USER` is a verified
wallet-bound session acting only for itself. `AGENT_SESSION` is an active,
signature-verified Hermes session with an allowed action. `OPERATOR` and
`ADMIN` must be server-side allowlisted roles; a role in JSON is never evidence.

| Route | Required role | Mutates | Moves money | Compliance | Chain op |
|---|---|---:|---:|---:|---:|
| GET `/api/tokens`, `/api/tokens/:id`, `/api/evm/tokens` | PUBLIC_READ | no | no | no | no |
| POST `/api/tokens`, `/api/evm/tokens` | OPERATOR | yes | yes | yes | yes |
| GET `/api/tokens/:id/balance`, `/chat`, `/api/subgraph`, `/api/runtime-config`, `/api/x402/directory`, `/api/yield/streams` | PUBLIC_READ | no | no | no | no |
| POST `/api/tokens/:id/holders` | OPERATOR | yes | no | yes | no |
| POST `/api/tokens/:id/transfer` | OPERATOR | yes | yes | no | yes |
| POST `/api/tokens/:id/pause` | OPERATOR | yes | no | yes | yes |
| POST `/api/tokens/:id/holders/:accountId/whitelist`, `/revoke` | OPERATOR | yes | no | yes | yes |
| POST `/api/tokens/:id/holders/:accountId/reclaim-now`, `/cancel-schedule` | OPERATOR | yes | yes | yes | yes |
| POST `/api/tokens/:id/holders/:accountId/associate`, `/allowance` | AUTHENTICATED_USER (self) | yes | no | no | verification read |
| POST `/api/tokens/:id/holders/:accountId/checkin` | AUTHENTICATED_USER (self) | yes | no | compliance | possibly |
| POST `/api/tokens/:id/holders/:accountId/worldid-*` | AUTHENTICATED_USER (self) / AGENT_SESSION verify worker | yes | no | yes | no |
| POST `/api/tokens/:id/requests` | AUTHENTICATED_USER (self) | yes | no | no | no |
| GET `/api/token-requests*`, `/api/worldid/verifications*` | AGENT_SESSION | no | no | no | no |
| POST `/api/token-requests/:id/fulfill`, `/reject`, `/api/worldid/verifications/:id/verify` | AGENT_SESSION | yes | yes | yes | yes |
| POST `/api/agent/session` | AUTHENTICATED_USER (signature) | yes | no | no | no |
| GET `/api/agent/session` | AUTHENTICATED_USER (self) | no | no | no | no |
| POST `/api/agent/execute` | AGENT_SESSION | yes | yes | yes | yes |
| POST `/api/liveness/process` | AGENT_SESSION | yes | yes | yes | yes |
| POST `/api/yield/claim` | AUTHENTICATED_USER (self) | no until real settlement | yes | yes | future | 
| POST `/api/yield/streams` | OPERATOR | yes | yes | no | future |
| POST `/api/rent/simulate` | OPERATOR | yes | no (simulation) | no | no |
| POST `/api/x402/property-oracle` | PUBLIC (payment challenge/verification) | invoice state only | no | no | verification read |
| POST `/api/x402/settle` | AGENT_SESSION | yes | yes | no | yes |
| POST `/api/worldid/rp-signature`, `/verify-selfie`, `/verify-identity` | AUTHENTICATED_USER (self) | yes | no | compliance | no |

The audit found privileged routes without an authorization boundary, including
token creation, holder/compliance operations, stream writes, rent simulation,
and World ID routes. They require the role gates above before deployment.
