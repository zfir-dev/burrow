# Private services (Cloudflare Access)

Services are public by default. Add `private: true` to put a service's hostname behind
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/),
so visitors have to sign in with an allowed email first (Cloudflare's one-time PIN login
works without any identity provider setup).

```yaml
project: acme-shop
services:
  - name: app
    url: http://localhost:3100        # public
  - name: studio
    url: http://localhost:54323
    private: true
    allow: [ana@example.dev, "@example.dev"]   # emails, or @domain for a whole domain
  - name: mail
    url: http://localhost:54324
    private: true                     # uses BURROW_ACCESS_EMAILS
```

- `allow` takes emails and `@domain` entries. Without it, the service uses
  `BURROW_ACCESS_EMAILS` from the config (comma-separated). A private service with neither
  makes `up` fail before anything is changed.
- On `burrow up`, each private hostname gets a **self-hosted Access application** named
  `burrow:<project>:<service>` with the Access tag `burrow`, and one allow policy
  (`burrow:allow`) whose include rules are the allow list. Running `up` again only changes
  what differs: a new allow list updates the policy, and removing `private: true` deletes the
  app, so the hostname is public again.
- `burrow destroy` deletes the project's apps. `burrow prune` lists and deletes burrow apps
  whose project has no local state, like orphaned tunnels.
- burrow only touches apps that have **both** the `burrow` tag and a `burrow:` name. If a
  hostname already has an Access app that burrow doesn't own, burrow leaves it alone and says so.
- Path rules (`paths:`) share their service's hostname, so they're covered by its app.
- Projects that never used `private: true` make no Access API calls at all, so tokens without
  the Access permission keep working for everything else.

## Token permission

Add **Account > Access: Apps and Policies > Edit** to the API token. Without it, `up` for a
project with private services fails with a message naming this permission, and `prune` skips
Access apps.
