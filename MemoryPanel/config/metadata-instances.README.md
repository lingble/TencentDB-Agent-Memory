# metadata-instances.json field reference (new stateless panel)

| Field | Required | Description |
|------|------|------|
| `id` | Yes | = `instance_id` = kernel `x-tdai-service-id`; typically `default` locally, `mem-{slug}` in production |
| `name` | Yes | Display name on the login page; exposed **only** via `GET /api/v1/meta/instances` |
| `gateway_endpoint` | Yes | Memory Gateway root URL; locally `http://127.0.0.1:8420`. **This is the forwarding address from the Panel backend to the Kernel; do not point it at the proxy** |
| `proxy_endpoint` | No | Client access baseUrl (CodeBuddy / ClaudeCode CLI, etc.). Used **only** to build the URL shown on the Panel UI "Client Access Endpoint" card. Falls back to `gateway_endpoint` when omitted, matching the old behavior. In production deployments where a proxy fronts the gateway, the two values are the same and this can be omitted; in local open-source deployments where core and proxy run separately, set this to the proxy's public address (e.g. `http://127.0.0.1:8096`) |
| `api_key` | Yes | Gateway Bearer token; used **only server-side** for forwarding, and **never** appears in the instances API |

## Local file (contains secrets, not committed)

```bash
cp config/metadata-instances.example.json config/metadata-instances.json
# Then fill in gateway_endpoint / api_key for your local Gateway
```

`config/metadata-instances.json` is in `.gitignore`; the repo only keeps `metadata-instances.example.json`.

> **Upgrade note**: Before your first pull of the commit that removes this file from the repo, back up your local `metadata-instances.json`. If the file is deleted after the pull, restore it from the backup, or copy it again from the example as above and fill in the key.
