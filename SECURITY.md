# Security Policy

Frolo controls sensitive infrastructure, including Proxmox virtual machines, SSH connections, router configurations, and reverse proxies. Security reports are taken seriously.

## Beta status

Frolo is currently beta software. Do not use it as the only management method for critical production infrastructure.

Before using Frolo:

- Keep working backups of important virtual machines.
- Use a dedicated restricted Proxmox API token.
- Review deployment and networking plans before applying them.
- Keep the Frolo panel inside a trusted network.
- Do not expose port `4512` directly to the internet.
- Use HTTPS through a trusted reverse proxy when remote access is required.

## Reporting a vulnerability

Please report vulnerabilities using GitHub Private Vulnerability Reporting for this repository.

Do not create a public GitHub issue for an unpatched vulnerability. Include:

- A description of the vulnerability
- The affected Frolo version
- Steps to reproduce it
- Its possible impact
- Relevant logs with credentials and personal information removed
- A suggested fix, if you have one

Please allow reasonable time for investigation and a release before publicly discussing the vulnerability.

## Sensitive information

Never include these values in an issue, report, screenshot, recording, or log:

- Proxmox API tokens
- Router usernames or passwords
- Session cookies
- Authorization headers
- CSRF tokens
- SSH private keys
- Vault recovery codes
- Frolo signing keys
- Public IP addresses you do not want disclosed

Replace sensitive values with obvious placeholders.

## Security model

Frolo stores infrastructure credentials locally in an encrypted vault. The public Frolo App contains only the public key needed to verify signed licenses. Production license-signing keys and supporter records belong to the separate private Frolo Server.

Frolo should never send Proxmox credentials, router passwords, SSH private keys, or vault recovery codes to the private frolo-server or any other remote service.

## Supported versions

During beta, security fixes are provided only for the newest available release. Users should update Frolo before reporting a problem that may already be fixed.

## Responsible testing

Only test Frolo against infrastructure and accounts you own or have explicit permission to manage. Do not disrupt other users, access their information, or test attacks against public services without authorization.
