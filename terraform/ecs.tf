# One long-lived task (the app keeps caches and job state in process; CLAUDE.md). During a deploy the new task starts before the old
# one stops: the background jobs' Postgres advisory lock keeps one leader, and scripts/migrate.mjs runs before the server starts.

locals {
  environment = merge({
    NODE_ENV                          = "production"
    BROKER                            = "sim"
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = var.clerk_publishable_key
    DB_HOST                           = aws_db_instance.main.address
    DB_PORT                           = tostring(aws_db_instance.main.port)
    DB_NAME                           = aws_db_instance.main.db_name
    DB_USER                           = aws_db_instance.main.username
    DB_SSL                            = "true"
    DB_SSL_CA                         = "/app/certs/rds-global-bundle.pem"
    # Production has no dev routes (the "Advance transfers" button), so transfers and reviews move along on their own
    SIM_FUNDING_FAST_SECONDS = "10"
    SIM_KYC_SECONDS          = "5"
    SIM_KYC_REVIEW_SECONDS   = "30"
  }, var.extra_env)

  db_password_secret_arn = aws_db_instance.main.master_user_secret[0].secret_arn
}

resource "aws_ecs_cluster" "main" {
  name = var.name
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.name}"
  retention_in_days = 30
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Used by ECS to pull the image, write logs and read the secrets; the app itself calls no AWS API, so there's no task role
resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions   = ["ssm:GetParameters"]
    resources = [for parameter in aws_ssm_parameter.secret : parameter.arn]
  }

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.db_password_secret_arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

resource "aws_ecs_task_definition" "app" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([{
    name         = "app"
    image        = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
    essential    = true
    portMappings = [{ containerPort = 3000, protocol = "tcp" }]
    environment  = [for name, value in local.environment : { name = name, value = value }]
    secrets = concat(
      [for name, parameter in aws_ssm_parameter.secret : { name = name, valueFrom = parameter.arn }],
      [{ name = "DB_PASSWORD", valueFrom = "${local.db_password_secret_arn}:password::" }]
    )
    stopTimeout = 30
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "app"
      }
    }
  }])
}

resource "aws_ecs_service" "app" {
  name                               = var.name
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.app.arn
  desired_count                      = 1
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  # Room for the migrations and the first compile of the health route
  health_check_grace_period_seconds = 120
  propagate_tags                    = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener.https]
}
