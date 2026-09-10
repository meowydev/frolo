# Private-service boundary

This public repository contains the **self-hosted Frolo web application** and everything
needed to build, run, and test it in mock mode. Some things **must live outside**
this repository, in a separate closed-source service. This document draws that
line explicitly so nothing sensitive is ever committed here.

## What lives in this PUBLIC repository

- The Fastify server, local controller, React web panel, and installer.
- All domain logic, providers (fake + real), vault, store, controller.
- The offline license **verifier** and the **public** verification key(s).
- A **development-only** fake license issuer and admin CLI that mint clearly
  marked `dev-fake` licenses using an ephemeral key generated at runtime.
- Tests, fixtures, and documentation.

## What MUST live in the PRIVATE service (never here)

1. **The production signing private key.**
   - Ed25519 private key used to sign real licenses.
   - Stored in an HSM or a managed secret store — never on disk in a repo, never
     in builds, fixtures, logs, CI variables of this repo, or tests.
2. **Boosty subscriber records.**
   - The mapping from Boosty supporters to device codes and issued licenses.
   - Any personal data associated with subscribers.
3. **The hosted issuance endpoint / admin tooling** that:
   - receives a supporter's device code (sent from their subscribed Boosty
     account),
   - verifies the subscription against Boosty,
   - and signs a license with the production key.

## The contract between them

The public client and the private service agree only on a small, non-secret
contract, defined in `@frolo/contracts`:

- **License payload** (`LicensePayload`): `{ v, subject, tier, issuedAt,
  expiresAt, graceDays, licenseId, keyId }`.
- **Signed license** (`SignedLicense`): `{ payload, signature (base64url
  ed25519), alg: "ed25519" }`, over the canonical JSON of the payload.
- **Public key** (`PublicVerificationKey`): `{ keyId, alg, publicKey
  (base64url), environment }`. The app ships production keys and refuses
  `development` keys in production builds.

### Admin issuance I/O contract (implemented by the private service)

The private service must implement the same input/output shape the dev CLI
documents (`packages/licensing/src/cli/dev-issue.ts`):

```
input:  { "subject": string,
          "tier": "home" | "advanced_user" | "powerfullness",
          "validityDays"?: number,   // default 35
          "graceDays"?: number,      // default 5
          "licenseId"?: string }
output: { "license": SignedLicense, "publicKey": PublicVerificationKey }
```

The **only** difference between the dev CLI and the production service is where
the signing key comes from: the dev CLI uses an ephemeral non-production key;
the production service uses the protected production key from its secret store.

## Publishing public keys

When a production key is created in the private service, only its **public** half
is published (e.g. as a non-secret `keys.json`) and embedded in the self-hosted
application through its public-key configuration. The private half never leaves
the service.

## Why this split

Because the client is open-source and inspectable, entitlement authenticity is
protected by **asymmetric signatures**, not by hiding client logic. Keeping the
signing key and subscriber data in a private service is what makes the free,
open client and a sustainable subscription model coexist safely.
