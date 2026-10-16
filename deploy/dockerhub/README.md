# Docker Hub Image Publishing

Builds the three-piece image set and pushes it to the
[`agentmemory`](https://hub.docker.com/u/agentmemory) namespace on Docker Hub.

`publish.sh` is self-contained: it depends only on each component's own Dockerfile,
`deploy/panel-knowledge-combined/build.sh` and `MemoryPanel/scripts/secret-scan.sh`.

## Components and image names

| Component | Build context | Image |
|---|---|---|
| `memory-core` | `MemoryCore/` | `agentmemory/memory-core` |
| `memory-proxy` | `MemoryProxy/` (rsynced into a temporary context) | `agentmemory/memory-proxy` |
| `memory-hub` | `MemoryPanel/` + `MemoryKnowledge/` combined | `agentmemory/memory-hub` |

## Prerequisites

```bash
docker login docker.io          # the account needs push access to agentmemory
docker buildx version           # buildx is required (the script creates a builder automatically)
```

## Usage

```bash
cd deploy/dockerhub

# Publish all three images at once
VERSION=1.0.0 ./publish.sh all

# A single component
VERSION=1.0.0 ./publish.sh memory-core
VERSION=1.0.0 ./publish.sh memory-proxy
VERSION=1.0.0 ./publish.sh memory-hub

# Dry run: only secret-scan and context preparation, no build, no push
DRY_RUN=1 VERSION=1.0.0 ./publish.sh all

# Local single-arch build to spot-check image contents, no push
PUSH=0 VERSION=1.0.0 ./publish.sh memory-core

# Also update :latest
ALSO_LATEST=1 VERSION=1.0.0 ./publish.sh all
```

`VERSION` is required and values starting with `dev-` are rejected, so development tags never get pushed publicly.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `VERSION` | none (required) | Image tag |
| `NAMESPACE` | `agentmemory` | Docker Hub namespace |
| `REGISTRY` | `docker.io` | Target registry |
| `PLATFORMS` | `linux/amd64,linux/arm64` | Multi-arch build targets |
| `ALSO_LATEST` | `0` | Whether to also push `:latest` |
| `PUSH` | `1` | Set to `0` to `--load` a single-arch image locally without pushing |
| `DRY_RUN` | `0` | Set to `1` to run only the scan and context preparation |
| `LOAD_PLATFORM` | `linux/amd64` | Architecture for the local build when `PUSH=0` |
| `KEEP_CTX` | `0` | Set to `1` to reuse the previous temporary context |
| `APT_MIRROR` | `deb.debian.org` | apt source used at build time; on an internal network, point it at a faster mirror |

## Faster apt at build time

All four Dockerfiles take the apt source from the `APT_MIRROR` build-arg. It defaults to the official Debian mirror,
which works out of the box on the public internet. To speed up builds on an internal network, pass this one variable; the resulting images are unaffected:

```bash
APT_MIRROR=<your-debian-mirror> VERSION=1.0.0 ./publish.sh all
```

## Optional private modules

- `MemoryProxy/packages/cost-guard` is an optional extension and is not included in the public image. `publish.sh`
  generates a stub package in the temporary context so the dependency graph resolves; at runtime, when the dynamic
  import in `src/guard-adapter.ts` fails, the proxy automatically falls back to plain passthrough forwarding.
- `MemoryCore/src/integrations` works the same way: it is excluded in `MemoryCore/.dockerignore`
  and the runtime uses the fallback.

## Verification

```bash
docker pull agentmemory/memory-core:1.0.0
docker buildx imagetools inspect agentmemory/memory-core:1.0.0
```
