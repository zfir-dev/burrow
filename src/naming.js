// Hostname rules. Only flat, one-level names under the tunnel domain so
// Cloudflare's free Universal SSL certificate (*.domain) covers them:
//   root service  -> <project>.<domain>
//   sub-service   -> <service>-<project>.<domain>
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function assertLabel(value, what) {
  if (typeof value !== 'string' || !LABEL_RE.test(value)) {
    throw new Error(
      `Invalid ${what} "${value}": use lowercase letters, digits and inner hyphens only (no dots).`
    );
  }
}

export function assertDomain(domain) {
  if (typeof domain !== 'string' || !domain.includes('.')) {
    throw new Error(`Invalid domain "${domain}". Set BURROW_DOMAIN in the burrow config, e.g. BURROW_DOMAIN=example.dev`);
  }
  for (const part of domain.split('.')) assertLabel(part, 'domain label');
}

export function hostnameFor(project, service, domain) {
  assertLabel(project, 'project name');
  assertDomain(domain);
  let label;
  if (service.root) {
    label = project;
  } else {
    assertLabel(service.name, 'service name');
    label = `${service.name}-${project}`;
  }
  if (label.length > 63) throw new Error(`Hostname label "${label}" is longer than 63 characters.`);
  return `${label}.${domain}`;
}

export const tunnelName = (project) => `burrow-${project}`;
export const recordComment = (project) => `burrow:${project}`;
export const tunnelTarget = (tunnelId) => `${tunnelId}.cfargotunnel.com`;
