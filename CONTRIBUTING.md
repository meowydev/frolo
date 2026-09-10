# Contributing to Frolo

Thank you for helping improve Frolo. Contributions of code, testing, documentation, recipes, router profiles, translations, accessibility improvements, and design work are welcome.

## Before contributing

Frolo is beta software that can modify virtual machines and network configurations. Changes affecting Proxmox, SSH, routers, credentials, reverse proxies, authentication, or licensing require careful review and meaningful tests.

For larger changes, open a discussion or feature request before writing the complete implementation. Explain the problem, proposed behavior, and any security implications.

## Development process

1. Fork the repository.
2. Create a focused branch.
3. Make a small, understandable change.
4. Add or update meaningful tests when behavior changes.
5. Run the project checks.
6. Open a pull request describing the result.

Keep pull requests focused on one problem whenever practical.

## Pull requests

A useful pull request explains:

- What problem it solves
- What behavior changed
- How the change was tested
- Any security or compatibility concerns
- Screenshots for visible interface changes

Do not include generated build artifacts unless the repository specifically requires them.

## Code guidelines

- Follow the existing TypeScript style.
- Keep privileged operations out of the browser interface.
- Validate all data crossing an API or provider boundary.
- Keep secrets out of logs, errors, fixtures, tests, and recorded workflows.
- Use declarative, constrained recipe operations.
- Preserve infrastructure when an operation fails.
- Never silently open public ports or delete resources.
- Display observed status instead of simulated progress.
- Keep the interface accessible and responsive.

## Application recipes

Recipes must:

- Declare their name, version, supported operating systems, and architecture
- Use known typed operations
- Restrict writable paths, packages, and services
- Include installation and health checks
- Describe rollback or recovery behavior
- Avoid arbitrary downloaded scripts
- Avoid embedded credentials and private URLs

Official recipes require additional maintenance and security review.

## Router profiles

Only contribute router profiles that you have tested on hardware you own or are authorized to use.

Before submitting a profile:

- Remove usernames, passwords, cookies, tokens, addresses, and personal rule names.
- Use variable bindings for all credentials and deployment-specific values.
- State the exact router manufacturer, model, firmware version, and interface language.
- Document any manual checkpoints.
- Test create, find, verify, and delete workflows.

A router profile may stop working after a firmware update, so compatibility information must be precise.

## AI-assisted contributions

AI-assisted contributions are allowed, but the contributor remains responsible for understanding, reviewing, and testing everything submitted.

Do not submit large amounts of generated code that you cannot explain. Pull requests may be rejected if they contain invented APIs, unnecessary complexity, copied material, exposed secrets, or tests that do not verify real behavior.

Mention significant AI assistance in the pull request when it helps reviewers understand how the change was produced.

## Security reports

Do not submit public pull requests or issues containing details of an unpatched vulnerability. Follow [SECURITY.md](SECURITY.md).

## License

By contributing to Frolo, you agree that your contribution will be distributed under the repository’s GNU Affero General Public License v3.0.
