# phoenix-liveview Helm chart

A Helm chart for running a Phoenix LiveView application on EKS (target:
AWS GovCloud `us-gov-west-1`). The chart is deliberately opinionated for
**connection-holding workloads**: long-lived WebSockets, bursty traffic,
graceful drain on disruption.

## Install

```sh
# kind (verification)
helm upgrade --install phoenix-liveview ./helm/phoenix-liveview \
  -n phoenix --create-namespace

# production
helm upgrade --install phoenix-liveview ./helm/phoenix-liveview \
  -n phoenix --create-namespace \
  -f helm/phoenix-liveview/values.yaml \
  -f helm/phoenix-liveview/values-prod.yaml
```

## Required out-of-band Secret

The chart never templates secret material. Create a Secret named
`phoenix-liveview-runtime` (override via `secrets.existingSecret`) with:

| key                 | format                                  |
| ------------------- | --------------------------------------- |
| `SECRET_KEY_BASE`   | 64-byte hex (`mix phx.gen.secret`)      |
| `DATABASE_URL`      | `ecto://user:pass@host:5432/dbname`     |
| `RELEASE_COOKIE`    | arbitrary base64; shared by all pods    |

In a real GovCloud deploy, populate this Secret via External Secrets
Operator / AWS Secrets Manager — never `kubectl create secret` by hand
in CI.

## Files

| file                          | purpose                                             |
| ----------------------------- | --------------------------------------------------- |
| `templates/deployment.yaml`   | Pod spec — probes, preStop, security context        |
| `templates/service.yaml`      | ClusterIP + headless service for libcluster         |
| `templates/hpa.yaml`          | CPU baseline + custom-metric stub                   |
| `templates/pdb.yaml`          | `maxUnavailable: 1` for voluntary disruption        |
| `templates/serviceaccount.yaml`, `templates/rbac.yaml` | IRSA-ready SA + namespaced Role |
| `templates/configmap.yaml`    | Non-secret env (PHX_HOST, pool size, log level)     |
| `templates/networkpolicy.yaml`| Lock egress to RDS + DNS; ingress from controller   |
| `templates/servicemonitor.yaml`| Optional prom-operator scrape target               |

See the parent repo's `README.md` for the full design narrative.
