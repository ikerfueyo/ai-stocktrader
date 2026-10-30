variable "aws_region" {
  description = "Region for every resource"
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Prefix for resource names"
  type        = string
  default     = "ai-stocktrader"
}

variable "domain" {
  description = "The public hostname, such as stocktrader.example.com"
  type        = string
}

variable "route53_zone_id" {
  description = "The Route 53 hosted zone of the domain, to create the certificate's validation records and the alias; empty when DNS is elsewhere"
  type        = string
  default     = ""
}

variable "image_tag" {
  description = "The ECR image tag to run (scripts/deploy.sh passes the git SHA)"
  type        = string
}

variable "task_cpu" {
  description = "Fargate task CPU units"
  type        = number
  default     = 1024
}

variable "task_memory" {
  description = "Fargate task memory (MiB)"
  type        = number
  default     = 2048
}

variable "cpu_architecture" {
  description = "X86_64, or ARM64 (Graviton, about 20% cheaper) when the image is built on an ARM machine; scripts/deploy.sh builds for it"
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.micro"
}

variable "alert_email" {
  description = "Where the budget alerts go"
  type        = string
}

variable "monthly_budget" {
  description = "Monthly cost (before credits) that triggers the budget alerts, in USD"
  type        = number
  default     = 100
}

variable "clerk_publishable_key" {
  description = "Clerk's publishable key (public; also built into the client bundle by scripts/deploy.sh)"
  type        = string
}

variable "clerk_secret_key" {
  description = "Clerk's secret key"
  type        = string
  sensitive   = true
}

variable "alpha_vantage_api_key" {
  description = "Alpha Vantage API key (premium, with the realtime entitlement)"
  type        = string
  sensitive   = true
}

variable "openai_api_key" {
  description = "OpenAI API key"
  type        = string
  sensitive   = true
}

variable "alpaca_api_key_id" {
  description = "Alpaca Trading API key ID, used for market data only; empty to run without Alpaca's data"
  type        = string
  sensitive   = true
  default     = ""
}

variable "alpaca_api_secret_key" {
  description = "Alpaca Trading API secret key; empty to run without Alpaca's data"
  type        = string
  sensitive   = true
  default     = ""
}

variable "extra_env" {
  description = "More plain environment variables for the app (see CLAUDE.md's Setup), merged over the defaults in ecs.tf"
  type        = map(string)
  default     = {}
}
