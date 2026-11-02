# The app's API keys as SSM SecureStrings, read by the task at start (ecs.tf); empty optional keys are left out
locals {
  secret_values = {
    CLERK_SECRET_KEY      = var.clerk_secret_key
    ALPHA_VANTAGE_API_KEY = var.alpha_vantage_api_key
    OPENAI_API_KEY        = var.openai_api_key
    ALPACA_API_KEY_ID     = var.alpaca_api_key_id
    ALPACA_API_SECRET_KEY = var.alpaca_api_secret_key
  }
  secret_names = toset(nonsensitive([for name, value in local.secret_values : name if value != ""]))
}

resource "aws_ssm_parameter" "secret" {
  for_each = local.secret_names
  name     = "/${var.name}/${each.key}"
  type     = "SecureString"
  value    = local.secret_values[each.key]
}
