# Convenience targets. Nothing here is required — `docker build` and
# `helm install` work standalone — but these capture the assembly
# steps so a new engineer doesn't have to read three READMEs.

UPSTREAM_REPO := https://github.com/chrismccord/phoenix_live_view_example.git
UPSTREAM_REF  := master
BUILD_DIR     := build/phoenix_live_view_example
IMAGE         := phoenix-liveview:dev

.DEFAULT_GOAL := help

.PHONY: help
help:           ## show this help
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.PHONY: fetch
fetch:          ## clone the upstream Phoenix app (idempotent)
	@if [ ! -d "$(BUILD_DIR)" ]; then \
		mkdir -p build; \
		git clone --depth 1 --branch $(UPSTREAM_REF) $(UPSTREAM_REPO) $(BUILD_DIR); \
	else \
		echo "[fetch] $(BUILD_DIR) already exists, skipping clone"; \
	fi

.PHONY: assemble
assemble: fetch ## stage Dockerfile + patches into the upstream tree
	cp Dockerfile $(BUILD_DIR)/
	cp .dockerignore $(BUILD_DIR)/
	mkdir -p $(BUILD_DIR)/patches
	cp patches/runtime.exs $(BUILD_DIR)/patches/

.PHONY: build
build: assemble ## docker build the production image
	cd $(BUILD_DIR) && docker build -t $(IMAGE) .

.PHONY: lint
lint:           ## helm lint the chart
	helm lint helm/phoenix-liveview

.PHONY: render
render:         ## render templates with the prod overlay
	helm template demo helm/phoenix-liveview \
		-f helm/phoenix-liveview/values.yaml \
		-f helm/phoenix-liveview/values-prod.yaml \
		--set rbac.create=true \
		--set networkPolicy.enabled=true \
		--set metrics.enabled=true

.PHONY: clean
clean:          ## drop the assembled build tree
	rm -rf build/

.PHONY: validate
validate: lint render ## run all static checks
	@echo "[validate] all checks passed"
