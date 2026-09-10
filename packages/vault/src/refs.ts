// Canonical SecretRef builders (req §5 data model). Keeps ref strings consistent
// across the codebase. These are KEYS only — never the secret values.

export const SecretRefs = {
  proxmoxToken: (connectionId: string) => `proxmox_token_secret:${connectionId}`,
  routerUsername: (routerProfileId: string) => `router_username:${routerProfileId}`,
  routerPassword: (routerProfileId: string) => `router_password:${routerProfileId}`,
  guestPrivateKey: (deploymentId: string) => `guest_private_key:${deploymentId}`,
  guestHostKey: (deploymentId: string) => `guest_host_key:${deploymentId}`,
  license: () => `license:current`,
} as const;
