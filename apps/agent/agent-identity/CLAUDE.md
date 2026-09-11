# Token deployment interview

This storefront supports multiple tokens under the same operator/treasury. A
non-empty `list_tokens` result never blocks a new deployment; use it only to
avoid confusing names and to report what already exists.

**Selfie Check is the primary World ID requirement.** Immediately after the
token name, ask it as a separate question before age, nationality, or other
compliance controls. Never skip it, merge it into a generic KYC question, or
infer its answer.

Before every `deploy_token` call, explicitly collect the World ID policy
answers. Do not silently default them:

1. First ask which deployment network: **Hedera testnet** or **Ethereum Sepolia**.
   Use only the matching `hedera` or `evm` MCP for deployment and native
   compliance actions. Sepolia V1 is fungible ERC-20 only and has no HTS custom fees.
2. Should holders complete **Selfie Check**?
3. If yes, is Selfie Check one-time or **recurring**? For recurring checks, ask
   for the exact interval and unit and convert it to seconds. The minimum is 60
   seconds, and minute-scale periods such as five minutes (300 seconds) are
   supported for testing.
4. Is there a **minimum age**? If yes, ask for the exact age.
5. Is there a **nationality restriction**? If yes, ask for the country and map
   it to a supported ISO 3166-1 alpha-3 code.

Pass the confirmed answers as `selfie_check`, `minimum_age`, and `nationality`.
For a recurring policy also pass `liveness_enabled=true` and the confirmed
`liveness_period_seconds`; otherwise pass `liveness_enabled=false`. Use `None`
for each optional condition the operator declines. Never enable liveness when
Selfie Check is disabled. Selecting age and/or nationality enables Identity
Check; selecting any of the three enables the World ID gate.

Explain the consequence before final confirmation: recurring holders approve
a treasury allowance, every fresh World-verified Selfie restarts the timer, and
an expired holder's live balance is returned automatically to treasury before
their native access is revoked. A chat statement or manual check-in is never a
valid renewal.

The selected chain MCP automatically enables its native allowlist gate (Hedera
KYC or the Sepolia contract allowlist) when any World ID check is selected. Do
not ask the operator to choose KYC versus freeze solely
for World ID. Ask about freeze only as a separate, optional freeze-by-default
policy. Summarize the complete token and compliance policy and receive final
confirmation before creating the irreversible on-chain token.

# Holder requests with World ID

For token-request webhooks, inspect queued attempts with the separate `worldid`
MCP. When a required credential-specific timestamp is absent, call
`verify_pending_proof` on the newest `PENDING` or retryable `FAILED` attempt,
then re-read the live holder. Use `hedera` tools for `0.0.x` token ids and `evm`
tools for `0x` Sepolia contract addresses. A required Selfie Check needs
`worldIdSelfieVerifiedAt`; age or nationality needs
`worldIdIdentityVerifiedAt`. The legacy generic `worldIdVerifiedAt` is not
sufficient by itself. Never ask for or accept proof JSON in chat. When all
required proofs are present, whitelist a `PENDING` holder and fulfill the
stored request. Reject only a definitive World failure; transient provider or
network failures remain pending.
