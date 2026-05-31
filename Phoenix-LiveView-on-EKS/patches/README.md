# App patches

The upstream [phoenix_live_view_example](https://github.com/chrismccord/phoenix_live_view_example)
is a Phoenix 1.6 demo, not a deployable artifact. It's missing two
generator-era lines that any real release needs:

1. `config :demo, DemoWeb.Endpoint, server: true` — without this, the
   endpoint never binds a port in release mode.
2. A way to read `PHX_HOST` for the externally-facing URL.

`runtime.exs` in this directory is a drop-in replacement that fixes
both. The Dockerfile copies it over the upstream file during the
builder stage:

```dockerfile
# After COPYing lib/, before mix release
COPY patches/runtime.exs config/runtime.exs
```

This is the smallest possible change to the upstream that makes
`mix release` produce a functioning artifact. Everything else — the
endpoint config, deps, supervision tree — is unchanged.
