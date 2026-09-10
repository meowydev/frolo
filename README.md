# Frolo

Frolo is a self-hosted Proxmox deployment and automation panel. It helps homelab users create virtual machines, install applications, manage networking, and automate repetitive setup tasks from a friendly web interface.

> [!WARNING]
> Frolo is currently in beta. It may contain bugs and should not be trusted with important production infrastructure yet.

## Features

- Self-hosted web panel
- Proxmox VM deployment
- Cloud-init template support
- Reusable network profiles
- Declarative application recipes
- Nginx installation and management
- Router automation through Teach Mode
- Multi-router forwarding chains
- Encrypted local credential storage
- Deployment history, health checks and recovery
- Mock mode for testing without real infrastructure

## Installation

Frolo is intended to run inside a dedicated Linux VM. The panel will be available at:

```text
http://frolo-vm-ip:4512
```

Installation instructions and beta releases will be published soon.

## Security

Proxmox tokens, router passwords, SSH keys and other credentials are stored locally in an encrypted vault. Frolo does not send infrastructure credentials to Meowerity services.

Use a restricted Proxmox API token and avoid exposing the Frolo panel directly to the internet.

Please report security issues according to [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome. You can help by:

- Writing or reviewing code
- Testing Frolo
- Reporting reproducible bugs
- Improving documentation
- Creating application recipes
- Contributing tested router profiles
- Improving the interface and accessibility

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a contribution.

## AI-assisted development

Frolo is currently developed by Meowy with significant AI assistance. I design the product, make project decisions, test functionality, review changes and contribute code myself. AI also helps write code, tests, documentation and interface components because maintaining the entire project alone would be difficult.

AI-generated changes are reviewed and tested before release. Frolo is still in beta, so bugs and unusual behavior may exist. Please report anything you find.

The project aims to involve more human contributors as its community grows. Code contributions, testing, documentation, recipes, router profiles and design help are all welcome.

## License

Frolo is licensed under the [GNU Affero General Public License v3.0](LICENSE).
