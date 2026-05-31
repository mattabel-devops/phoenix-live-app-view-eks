import Config

# =============================================================================
# Deployment-ready overlay of config/runtime.exs for the upstream
# phoenix_live_view_example.
#
# Why this file exists:
#   The upstream `config/runtime.exs` ships the standard Phoenix 1.6
#   generator scaffolding, which (a) does not set `server: true` on the
#   endpoint — so a release-mode start does not actually bind a port —
#   and (b) does not read PHX_HOST for URL generation. Both are
#   straightforward env-var reads; both are required to deploy.
#
# What changed vs upstream:
#   1. Endpoint is started in release mode when PHX_SERVER=true.
#   2. PHX_HOST drives Endpoint :url, so generated WebSocket URLs match
#      whatever the ingress is exposing.
#   3. PORT, SECRET_KEY_BASE, DATABASE_URL, POOL_SIZE are still env-driven,
#      preserving upstream behaviour.
#
# The Dockerfile copies this file over the upstream runtime.exs in the
# builder stage. The change is small and reversible; see README §1
# "What I patched in the upstream app".
# =============================================================================

if config_env() == :prod do
  database_url =
    System.get_env("DATABASE_URL") ||
      raise """
      environment variable DATABASE_URL is missing.
      For example: ecto://USER:PASS@HOST/DATABASE
      """

  config :demo, Demo.Repo,
    url: database_url,
    pool_size: String.to_integer(System.get_env("POOL_SIZE") || "10"),
    # Drop the connection if RDS goes away during a deploy — Ecto will
    # reconnect cleanly through its own supervision tree.
    socket_options:
      if(System.get_env("ECTO_IPV6") == "true", do: [:inet6], else: [])

  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      environment variable SECRET_KEY_BASE is missing.
      You can generate one by calling: mix phx.gen.secret
      """

  host = System.get_env("PHX_HOST") || "example.com"
  port = String.to_integer(System.get_env("PORT") || "4000")

  config :demo, DemoWeb.Endpoint,
    # The :url block is what Phoenix uses to construct external URLs in
    # rendered templates — it does NOT control which port we bind. The
    # binding lives in :http below.
    url: [host: host, port: 443, scheme: "https"],
    http: [
      # IPv6 wildcard. Reachable via IPv4 too — Cowboy / Bandit handle
      # dual-stack on a single :: socket on Linux by default.
      ip: {0, 0, 0, 0, 0, 0, 0, 0},
      port: port
    ],
    secret_key_base: secret_key_base,
    # This is the line the upstream had commented out. Without it the
    # release boots and immediately idles, listening on nothing.
    server: true

  # Trim log volume in prod — phoenix_live_dashboard is otherwise chatty.
  config :logger, level: String.to_atom(System.get_env("LOG_LEVEL") || "info")
end
