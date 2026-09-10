# Screenshots

The README currently uses `hero.svg`, a committed **illustrative placeholder**
(vector, so it renders in the README without a broken link). Real captures still
require running the panel in a browser, which can't be done in CI; replace the
placeholder with real captures before publishing.

Suggested captures (use **Try Frolo safely** / mock mode — never show real
Proxmox hosts, router UIs, IPs, or credentials):

- `hero.png` — the dashboard with the "Simulated infrastructure (mock)" chip and
  the beta label (then point the README at `hero.png` instead of `hero.svg`).
- `settings.png` — the Settings screen: real Proxmox connections + software
  updates cards.
- `oobe-welcome.png` — the OOBE welcome step.
- `oobe-mode.png` — the mode step ("Try Frolo safely" vs "Connect my Proxmox").
- `oobe-recovery.png` — the vault recovery-code step (blur/redact the code).
- `oobe-proxmox.png` — the Proxmox connect + Test Connection step.
- `dashboard.png` — deployment cards + the floating action button.
- `wizard.png` — the new-deployment form.
- `review.png` — the plan review dialog before deploying.
- `timeline.png` — the live deployment timeline (Material stepper) showing
  observed status like "HTTP 200, marker found".
- `details.png` — deployment details with the local and simulated public
  addresses.
- `dark.png` — the panel in dark mode (theme toggle in the app bar).

Guidelines:
- Capture in a browser at a desktop width (permanent nav drawer) and a phone
  width (compact drawer) to show responsiveness.
- Never capture real credentials, tokens, recovery codes, or private IPs.
