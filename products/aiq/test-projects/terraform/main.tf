terraform {
  required_version = ">= 1.0.0"
}

locals {
  effective_region = var.region
}

output "effective_region" {
  value = local.effective_region
}
