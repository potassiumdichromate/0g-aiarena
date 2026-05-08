variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for all resources"
  type        = string
  default     = "us-central1"
}

variable "cluster_name" {
  description = "GKE cluster name"
  type        = string
  default     = "ai-arena-prod"
}

variable "environment" {
  description = "Deployment environment (staging, prod)"
  type        = string
  default     = "prod"
}

variable "subnet_cidr" {
  description = "Primary subnet CIDR"
  type        = string
  default     = "10.0.0.0/20"
}

variable "pods_cidr" {
  description = "Secondary CIDR for pods"
  type        = string
  default     = "10.4.0.0/14"
}

variable "services_cidr" {
  description = "Secondary CIDR for services"
  type        = string
  default     = "10.0.32.0/20"
}

variable "general_machine_type" {
  description = "Machine type for general node pool"
  type        = string
  default     = "n2-standard-4"
}

variable "general_node_count" {
  description = "Initial node count per zone for general pool"
  type        = number
  default     = 2
}

variable "general_min_nodes" {
  description = "Min nodes for general pool autoscaling"
  type        = number
  default     = 1
}

variable "general_max_nodes" {
  description = "Max nodes for general pool autoscaling"
  type        = number
  default     = 10
}

variable "inference_machine_type" {
  description = "Machine type for inference node pool"
  type        = string
  default     = "n2-highmem-8"
}

variable "inference_node_count" {
  description = "Initial node count for inference pool"
  type        = number
  default     = 2
}

variable "inference_min_nodes" {
  description = "Min nodes for inference pool autoscaling"
  type        = number
  default     = 2
}

variable "inference_max_nodes" {
  description = "Max nodes for inference pool autoscaling"
  type        = number
  default     = 20
}

variable "db_tier" {
  description = "Cloud SQL instance tier"
  type        = string
  default     = "db-custom-4-15360"
}

variable "redis_memory_gb" {
  description = "Redis Memorystore memory size in GB"
  type        = number
  default     = 16
}

variable "redis_cidr" {
  description = "CIDR for Redis reserved IP range"
  type        = string
  default     = "10.0.48.0/29"
}
