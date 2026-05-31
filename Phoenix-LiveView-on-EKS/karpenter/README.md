# Karpenter — Phoenix LiveView NodePool

Two manifests, evaluated as code:

| file               | purpose                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `nodepool.yaml`    | Scheduling shape: instance families, sizes, capacity type, consolidation |
| `ec2nodeclass.yaml`| EC2 plumbing: AMI, subnets, security groups, IAM, IMDS, EBS              |

## TL;DR of the decisions

| dimension          | choice                            | why                                                                                |
| ------------------ | --------------------------------- | ---------------------------------------------------------------------------------- |
| instance families  | `c6i, c7i, m6i, m7i`              | Bursty CPU + memory-per-connection workload. No r/x (overkill), no t (burst CPU).  |
| sizes              | `large` – `4xlarge`               | Bin-pack floor; blast-radius ceiling.                                              |
| arch               | `amd64`                           | Some Elixir NIFs don't ship arm64 wheels. Future work.                             |
| capacity type      | `spot, on-demand` (spot preferred)| Cost win; 2-min interruption fits a 90s grace period + PDB.                        |
| consolidation      | `WhenEmptyOrUnderutilized` + 5m   | Repack the long tail; PDB caps disruption at one pod.                              |
| disruption budget  | `10%` nodes/min + business-hours freeze | Belt-and-braces against runaway churn.                                       |
| AMI                | AL2023 alias                      | cgroups v2; FIPS-capable OpenSSL.                                                  |
| IMDS               | v2 only, hop limit 1              | Block SSRF → instance role exfil.                                                  |
| storage            | gp3 100 GiB, KMS-encrypted        | Cheaper IOPS knob; encryption-at-rest by default in GovCloud.                      |

## GovCloud caveats

- IAM role ARNs use the `aws-us-gov` partition. Karpenter v1 reconstructs the
  ARN from the cluster's partition, so we pass the role *name* in
  `ec2nodeclass.yaml`. Don't paste an `arn:aws:iam:...` ARN by mistake.
- Not every commercial instance generation lands in `us-gov-west-1` on day
  one. `c7i` / `m7i` are present today, but if your account is in a region
  that lags (e.g. `us-gov-east-1`), drop them and stick with `c6i` / `m6i`.
- AMI IDs differ from the commercial partition. The `al2023@latest` alias
  resolves via SSM in the *local* partition, so this Just Works — but a
  hand-pinned AMI ID is a portability landmine.
- VPC endpoints: instances in private subnets need VPC endpoints for STS,
  EC2, ECR (api + dkr), and S3 for image pulls and Karpenter's own API
  calls. That's a cluster-bootstrap concern, not a Karpenter manifest one,
  but flag it during review.

## What's deliberately not in here

- A second "burst" NodePool for on-demand-only peak hours. Easy to add by
  cloning `nodepool.yaml`, setting `capacity-type: ["on-demand"]`, and
  giving it a higher `weight`. Skipped because the brief asks for
  deliberate, not exhaustive.
- Mixed instance interruption policies. Karpenter handles spot
  interruption notices natively via the SQS queue; in a real install,
  that queue gets created in the cluster's IaC and the Karpenter
  controller's IRSA role gets the SQS permissions. Not modelled here
  because there's no IaC layer in the deliverable.
