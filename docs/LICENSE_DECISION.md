# License decision

## Chosen license: GNU Affero General Public License v3.0

Frolo's public self-hosted application in this repository is released under the
**GNU Affero General Public License v3.0** (`AGPL-3.0-only`).

### Why AGPL-3.0

- **Users retain access to the source.** Anyone may use, inspect, modify, and
  redistribute Frolo under the license terms.
- **Network modifications stay open.** Anyone who operates a modified Frolo for
  users over a network must offer those users the corresponding source code.
- **Community improvements remain available.** A hosted commercial fork cannot
  keep modifications to the covered application private from its users.

### What the license does NOT cover

The open-source license applies to the code in this public repository. It does
**not** grant rights to:

- The **Frolo brand/name** and logo (trademark, reserved).
- The **private license-issuer service** and its production signing keys, which
  are closed-source and never present in this repository (see
  [PRIVATE_SERVICE_BOUNDARY.md](PRIVATE_SERVICE_BOUNDARY.md)).
- Any **Boosty subscriber data**, which lives only in the private service.

### Monetization and open source

The paid tiers (Frolo AdvancedUser, Frolo Powerfullness) are enforced by
**signed entitlements**, not by hiding client code. Because the client is
open-source and inspectable, entitlement authenticity is protected by asymmetric
signatures (the app holds only the public key). This keeps the free product fully
open while still allowing a sustainable subscription model. See
[LICENSING.md](LICENSING.md).

### Alternatives considered

- **MIT** — simpler and highly permissive, but allows closed-source commercial
  forks of the public application.
- **Apache-2.0** — adds an explicit patent grant but is still permissive and does
  not require hosted modifications to be offered to users.
