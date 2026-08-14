locals {
  name = "fixture-infra"
}

module "network" {
  source = "./modules/network"
}

module "app" {
  source = "./modules/app"
}
