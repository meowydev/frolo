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

## frolo-app vs frolo-server (web architecture)

The product is split into two explicit boundaries:

| | **frolo-app** (this repo, public/open) | **frolo-server** (private, Meowerity) |
| --- | --- | --- |
| What | The self-hosted web panel + local controller + deployment engine + local encrypted vault + recipes + license **verifier** + installer + packaging + tests | The hosted service for accounts, Boosty verification, production license **issuance**, signed update manifests, official recipe publishing, notifications, and future hosted features |
| Runs where | Inside the user's dedicated Linux VM, LAN-only on `:4512` | On Meowerity infrastructure |
| Keys | Ships only the **public** verification key | Holds the **private** signing key (HSM/secret store) |

### frolo-server MUST NEVER receive

- Proxmox API tokens
- Router administrator passwords
- SSH private keys or guest host keys
- Recorded router workflows or their variable values

Those live only in the user's local encrypted vault on the Frolo VM and never
leave it. frolo-server only ever sees a **device code** (a random, non-secret
identifier) and issues a signed entitlement in return.

### Future frolo-server responsibilities (documented, not implemented here)

- **Accounts + device codes**: map Boosty supporters to device codes and issued
  licenses.
- **Signed update manifests**: publish release metadata the app can verify with
  the same public-key mechanism before updating.
- **Official recipe publishing**: sign recipe packs so the app can verify them
  before running (the app already requires checksum-verified, typed recipes).
- **Optional notifications / monitoring**: opt-in, never receiving infrastructure
  secrets.

These are contracts and boundaries only. This public repo implements the
**client side** (verification) and a **development-only** issuer/CLI so the flow
can be exercised without any production secret.

## Why this split

Because the client is open-source and inspectable, entitlement authenticity is
protected by **asymmetric signatures**, not by hiding client logic. Keeping the
signing key and subscriber data in a private service is what makes the free,
open client and a sustainable subscription model coexist safely.
