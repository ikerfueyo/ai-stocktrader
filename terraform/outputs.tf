output "app_url" {
  value = "https://${var.domain}"
}

output "alb_dns_name" {
  description = "Point the domain here (a CNAME) when its DNS isn't in Route 53"
  value       = aws_lb.app.dns_name
}

output "certificate_validation_records" {
  description = "The CNAMEs that validate the certificate, to add where the domain's DNS is when it isn't in Route 53"
  value = [for option in aws_acm_certificate.app.domain_validation_options : {
    name  = option.resource_record_name
    type  = option.resource_record_type
    value = option.resource_record_value
  }]
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "service_name" {
  value = aws_ecs_service.app.name
}

output "log_group" {
  value = aws_cloudwatch_log_group.app.name
}

output "clerk_publishable_key" {
  description = "Built into the client bundle by scripts/deploy.sh"
  value       = var.clerk_publishable_key
}

output "docker_platform" {
  description = "The platform scripts/deploy.sh builds the image for"
  value       = var.cpu_architecture == "ARM64" ? "linux/arm64" : "linux/amd64"
}
