container "web" {
  image = "nginx:latest"
  port {
    internal = 80
    external = 8080
  }
}
