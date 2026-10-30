#!/usr/bin/env bash
# Builds the app's image, pushes it to ECR tagged with the git commit, and rolls the ECS service onto it with Terraform.
# The new task runs the migrations (scripts/migrate.mjs) before serving, and the old one stops once the new one is healthy.
# Needs Docker (with buildx), the AWS CLI signed in to the account, Terraform, and terraform/terraform.tfvars and backend.hcl.
# Usage: scripts/deploy.sh [--allow-dirty]
set -euo pipefail

cd "$(dirname "$0")/.."
TF="${TERRAFORM:-terraform}"
TF_DIR=terraform

if [[ "${1:-}" != "--allow-dirty" ]] && [[ -n "$(git status --porcelain)" ]]; then
    echo "Commit or stash your changes first (the image is tagged with the commit), or pass --allow-dirty." >&2
    exit 1
fi
TAG="$(git rev-parse --short=12 HEAD)"
[[ "${1:-}" == "--allow-dirty" && -n "$(git status --porcelain)" ]] && TAG="$TAG-dirty-$(date +%s)"

"$TF" -chdir="$TF_DIR" init -input=false -backend-config=backend.hcl >/dev/null

# The repository must exist before the first push
if ! "$TF" -chdir="$TF_DIR" output -raw ecr_repository_url >/dev/null 2>&1; then
    echo "Creating the ECR repository first"
    "$TF" -chdir="$TF_DIR" apply -input=false -auto-approve -target=aws_ecr_repository.app -target=aws_ecr_lifecycle_policy.app -var "image_tag=$TAG"
fi

REPO="$("$TF" -chdir="$TF_DIR" output -raw ecr_repository_url)"
REGISTRY="${REPO%%/*}"
REGION="$(echo "$REGISTRY" | cut -d. -f4)"
PLATFORM="$("$TF" -chdir="$TF_DIR" output -raw docker_platform 2>/dev/null || echo linux/amd64)"
CLERK_KEY="$("$TF" -chdir="$TF_DIR" output -raw clerk_publishable_key 2>/dev/null || sed -n 's/^clerk_publishable_key *= *"\(.*\)"/\1/p' "$TF_DIR/terraform.tfvars")"

echo "Building $REPO:$TAG for $PLATFORM"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker buildx build \
    --platform "$PLATFORM" \
    --build-arg "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$CLERK_KEY" \
    --build-arg NEXT_PUBLIC_DEMO=true \
    --tag "$REPO:$TAG" \
    --push \
    .

echo "Deploying $TAG"
"$TF" -chdir="$TF_DIR" apply -input=false -var "image_tag=$TAG"

CLUSTER="$("$TF" -chdir="$TF_DIR" output -raw cluster_name)"
SERVICE="$("$TF" -chdir="$TF_DIR" output -raw service_name)"
echo "Waiting for $SERVICE to become stable (the circuit breaker rolls back a failed deploy)"
aws ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"
echo "Deployed $TAG: $("$TF" -chdir="$TF_DIR" output -raw app_url)"
