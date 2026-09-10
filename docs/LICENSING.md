# Frolo licensing & tiers

Frolo's monetization is designed to keep the free product genuinely useful while
funding development. It uses **offline, signed entitlements** — no phone-home.

## Tiers

| Tier | Display name | Includes |
| --- | --- | --- |
| `home` | **Frolo Home** (free) | Local core deployment, Teach Mode, single-hop exposure |
| `advanced_user` | **Frolo AdvancedUser** | + multi-router chains, parallel deployments, template export |
| `powerfullness` | **Frolo Powerfullness** | + unlimited router hops, priority recipe catalog, advanced audit export |

(The tier names' spelling is intentional and part of the product identity.)

Frolo Home is not a crippled demo: you can clone a template, configure and boot a
VM, install Nginx, verify it, teach a router workflow, and expose through a single
router — all for free.

## How verification works

1. You open Frolo and copy your **device code** (a random, non-secret identifier,
   e.g. `FROLO-A1B2-C3D4-E5F6`).
2. From your **subscribed Boosty account**, you message that device code to the
   maintainers.
3. An admin issues a **signed license** using the private issuer service and sends
   it back to you.
4. You paste the license into Frolo. The app verifies the **Ed25519 signature**
   with a bundled **public key** and activates your tier — entirely offline.

Licenses are valid for **35 days** with a **5-day grace period** after expiry.

## License lifecycle

- **Active** — within the validity window; paid features enabled.
- **Grace** — expired but within the 5-day grace window; paid features still
  enabled, with a clear reminder to renew.
- **Expired** — past grace; the app reverts to **Frolo Home**.
- **Invalid** — signature/date/key check failed; the app runs as Frolo Home and
  explains why.

## Expiry never damages anything

This is a hard rule: **expiration only disables paid conveniences.** It never
deletes, stops, or modifies your VMs, router mappings, recipes, files, or
deployments. A lapsed subscriber who had a two-router chain simply loses the
multi-hop *convenience* — the mappings and VMs that already exist are untouched,
and Frolo tells you exactly that and how to renew.

## Security of the model

- The desktop app contains only the **public** key. The private signing key lives
  only in a separate, closed-source service (see
  [PRIVATE_SERVICE_BOUNDARY.md](PRIVATE_SERVICE_BOUNDARY.md)).
- Because distributed client code can be inspected, entitlement authenticity is
  protected by **signatures**, not obfuscation.
- Production builds refuse `development`-environment keys, so dev-fake licenses
  can never activate a shipped app.

## For developers

A development-only issuer and CLI let you exercise the whole flow without any
production secret:

```bash
pnpm --filter @frolo/licensing build
echo '{"subject":"my-device","tier":"advanced_user"}' \
  | node packages/licensing/dist/cli/dev-issue.js
```

This prints a `dev-fake` signed license and its public key, clearly marked as
non-production.
