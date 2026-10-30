resource "aws_db_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

# Postgres 16 requires SSL by default (rds.force_ssl), which the app's DB_SSL settings meet. The master password is kept by RDS in
# Secrets Manager and given to the task from there.
resource "aws_db_instance" "main" {
  identifier                  = var.name
  engine                      = "postgres"
  engine_version              = "16"
  auto_minor_version_upgrade  = true
  instance_class              = var.db_instance_class
  allocated_storage           = 20
  max_allocated_storage       = 50
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = "ai_stocktrader"
  username                    = "stocktrader"
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.main.name
  vpc_security_group_ids      = [aws_security_group.db.id]
  publicly_accessible         = false
  multi_az                    = false
  backup_retention_period     = 7
  copy_tags_to_snapshot       = true
  deletion_protection         = true
  skip_final_snapshot         = false
  final_snapshot_identifier   = "${var.name}-final"
}
