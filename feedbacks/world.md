# World

Context: We had integrated worldID in some other hackathon, so had a bit of knowledge of what World does and how it works.

## Selfie Check

- **Official app access:** the documentation initially led us towards TestFlight/Sandbox, although Selfie Check was already available in the official World App.
- **Environment selection:** `staging` only works with the World Simulator, while the official World App requires `production`. Using the World App with staging produced `invalid_merkle_root`.
- **Simulator coverage:** the simulator did not expose a Selfie Check/Face option during our initial testing, so the real flow had to be tested in production mode. Support was added during the hackathon.
- **Sybil score:** the current Selfie Check result does not include a Sybil score (which appears in the docs).

## Identity Check

- **Simulator access:** initially, testing required a supported passport or identity document. The World team then added Identity Check to the simulator, removing this blocker.
- **Nationality documentation:** the documentation should list every supported nationality and its expected value instead of requiring discovery through World App or the simulator.

## User experience

- **Proof chaining:** Selfie and Identity checks could continue in the same mobile session after a single scan, with document capture opening directly after the selfie. This would avoid reopening or rescanning the flow for each requirement.
