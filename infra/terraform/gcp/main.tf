terraform {
  required_version = ">= 1.7.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.20"
    }
  }
  backend "gcs" {
    bucket = "ai-arena-terraform-state"
    prefix = "prod/gke"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# VPC Network
resource "google_compute_network" "ai_arena_vpc" {
  name                    = "${var.cluster_name}-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "ai_arena_subnet" {
  name          = "${var.cluster_name}-subnet"
  ip_cidr_range = var.subnet_cidr
  region        = var.region
  network       = google_compute_network.ai_arena_vpc.id

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.pods_cidr
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = var.services_cidr
  }
}

# GKE Cluster
resource "google_container_cluster" "ai_arena" {
  name     = var.cluster_name
  location = var.region

  remove_default_node_pool = true
  initial_node_count       = 1

  network    = google_compute_network.ai_arena_vpc.name
  subnetwork = google_compute_subnetwork.ai_arena_subnet.name

  networking_mode = "VPC_NATIVE"

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  addons_config {
    horizontal_pod_autoscaling {
      disabled = false
    }
    http_load_balancing {
      disabled = false
    }
  }

  release_channel {
    channel = "REGULAR"
  }

  maintenance_policy {
    recurring_window {
      start_time = "2024-01-01T03:00:00Z"
      end_time   = "2024-01-01T07:00:00Z"
      recurrence = "FREQ=WEEKLY;BYDAY=SA"
    }
  }

  resource_labels = {
    environment = var.environment
    project     = "ai-arena"
  }
}

# General Purpose Node Pool
resource "google_container_node_pool" "general" {
  name       = "general"
  location   = var.region
  cluster    = google_container_cluster.ai_arena.name
  node_count = var.general_node_count

  node_config {
    machine_type = var.general_machine_type
    disk_size_gb = 100
    disk_type    = "pd-ssd"

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]

    labels = {
      pool        = "general"
      environment = var.environment
    }

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }

  autoscaling {
    min_node_count = var.general_min_nodes
    max_node_count = var.general_max_nodes
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }
}

# High-Memory Node Pool for inference
resource "google_container_node_pool" "inference" {
  name       = "inference"
  location   = var.region
  cluster    = google_container_cluster.ai_arena.name
  node_count = var.inference_node_count

  node_config {
    machine_type = var.inference_machine_type
    disk_size_gb = 200
    disk_type    = "pd-ssd"

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]

    labels = {
      pool        = "inference"
      environment = var.environment
    }

    taint {
      key    = "workload"
      value  = "inference"
      effect = "NO_SCHEDULE"
    }

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }

  autoscaling {
    min_node_count = var.inference_min_nodes
    max_node_count = var.inference_max_nodes
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }
}

# Cloud SQL (PostgreSQL)
resource "google_sql_database_instance" "main" {
  name             = "${var.cluster_name}-postgres"
  database_version = "POSTGRES_16"
  region           = var.region

  settings {
    tier              = var.db_tier
    availability_type = "REGIONAL"
    disk_autoresize   = true
    disk_size         = 100
    disk_type         = "PD_SSD"

    backup_configuration {
      enabled                        = true
      start_time                     = "03:00"
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 14
        retention_unit   = "COUNT"
      }
    }

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.ai_arena_vpc.id
    }

    insights_config {
      query_insights_enabled  = true
      query_string_length     = 1024
      record_application_tags = true
      record_client_address   = false
    }
  }

  deletion_protection = true
}

resource "google_sql_database" "aiarena" {
  name     = "aiarena"
  instance = google_sql_database_instance.main.name
}

# Redis (Memorystore)
resource "google_redis_instance" "cache" {
  name           = "${var.cluster_name}-redis"
  tier           = "STANDARD_HA"
  memory_size_gb = var.redis_memory_gb
  region         = var.region

  authorized_network = google_compute_network.ai_arena_vpc.id

  redis_version     = "REDIS_7_0"
  display_name      = "AI Arena Redis Cache"
  reserved_ip_range = var.redis_cidr

  persistence_config {
    persistence_mode    = "RDB"
    rdb_snapshot_period = "ONE_HOUR"
  }

  labels = {
    environment = var.environment
    project     = "ai-arena"
  }
}
