output "cluster_name" {
  description = "GKE cluster name"
  value       = google_container_cluster.ai_arena.name
}

output "cluster_endpoint" {
  description = "GKE cluster endpoint"
  value       = google_container_cluster.ai_arena.endpoint
  sensitive   = true
}

output "cluster_ca_certificate" {
  description = "GKE cluster CA certificate"
  value       = google_container_cluster.ai_arena.master_auth[0].cluster_ca_certificate
  sensitive   = true
}

output "postgres_connection_name" {
  description = "Cloud SQL connection name"
  value       = google_sql_database_instance.main.connection_name
}

output "postgres_private_ip" {
  description = "Cloud SQL private IP"
  value       = google_sql_database_instance.main.private_ip_address
  sensitive   = true
}

output "redis_host" {
  description = "Memorystore Redis host"
  value       = google_redis_instance.cache.host
  sensitive   = true
}

output "redis_port" {
  description = "Memorystore Redis port"
  value       = google_redis_instance.cache.port
}

output "vpc_name" {
  description = "VPC network name"
  value       = google_compute_network.ai_arena_vpc.name
}

output "kubectl_config_command" {
  description = "Command to configure kubectl"
  value       = "gcloud container clusters get-credentials ${google_container_cluster.ai_arena.name} --region ${var.region} --project ${var.project_id}"
}
