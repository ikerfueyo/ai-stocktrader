# AWS infrastructure

The public demo runs as one ECS Fargate task behind an Application Load Balancer, with RDS Postgres 16, all defined here. It costs
about $60 to $75 a month (the ALB, the task, `db.t4g.micro`, logs and public IPv4 addresses); the budget in `budget.tf` emails
`alert_email` when costs before credits pass 80% of `monthly_budget`.

| File | What it makes |
| --- | --- |
| `network.tf` | A VPC across two AZs: public subnets for the ALB and the task (no NAT gateway; the task has a public IP and accepts only the ALB), private ones for RDS, and the security groups |
| `alb.tf` | The ALB (HTTP redirected to HTTPS, idle timeout 120s), the target group checking `/api/health`, the ACM certificate and, with `route53_zone_id`, its validation records and the alias |
| `ecs.tf` | The cluster, the task definition (env and secrets) and the service (one task, rolling with the circuit breaker), logs kept 30 days |
| `rds.tf` | Postgres 16, private, encrypted, 7 days of backups, deletion protection, the master password kept by RDS in Secrets Manager |
| `secrets.tf` | The API keys as SSM SecureStrings, read by the task when it starts |
| `ecr.tf` | The image repository (immutable tags, the last 10 kept) |
| `budget.tf` | The monthly budget alert |
| `bootstrap/` | The S3 bucket holding this configuration's state |

## First deploy

1. Create the state bucket (once), then point the backend at it:
   ```sh
   terraform -chdir=terraform/bootstrap init && terraform -chdir=terraform/bootstrap apply
   cp terraform/backend.hcl.example terraform/backend.hcl   # set bucket to the state_bucket output, and the region
   cp terraform/terraform.tfvars.example terraform/terraform.tfvars   # fill in the domain, email and keys
   terraform -chdir=terraform init -backend-config=backend.hcl
   ```
2. If the domain's DNS isn't in Route 53, create the certificate first and add its validation CNAME where the DNS is:
   ```sh
   terraform -chdir=terraform apply -target=aws_acm_certificate.app -var image_tag=none
   terraform -chdir=terraform output certificate_validation_records
   ```
   After the first full deploy, point the domain at the `alb_dns_name` output with a CNAME.
3. In Clerk, create a production instance for the domain and add its DNS records; its keys go in `terraform.tfvars`.
4. Run `scripts/deploy.sh` from the repo root. It creates the ECR repository if needed, builds and pushes the image, applies the
   rest and waits for the service. Every later deploy is the same command.

The task runs `scripts/migrate.mjs` before the server: an empty database gets `db/schema.sql`, later ones the new files in
`db/migrations/`.

Logs: `aws logs tail /ecs/ai-stocktrader --follow`. To stop paying, `terraform destroy` (turn off `deletion_protection` in `rds.tf`
and apply first; RDS keeps a final snapshot).
