.PHONY: build test vet check coverage clean \
	license-add license-check english-check

GO          ?= go
BIN_DIR     := ./bin
BINARY_NAME := peri-code-review
EXE         := $(if $(filter Windows_NT,$(OS)),.exe,)

build:
	@mkdir -p $(BIN_DIR)
	$(GO) build -o $(BIN_DIR)/$(BINARY_NAME)$(EXE) ./cmd/peri-code-review

test:
	LC_ALL=C $(GO) test -race -count=1 ./...

vet:
	LC_ALL=C $(GO) vet ./...

check: license-check english-check
	gofmt -s -w .
	$(GO) mod tidy
	LC_ALL=C $(GO) vet ./...
	@echo "check passed"

# Coverage is reported for now. The previous 90% gate belonged to the OCR
# codebase; raise it once the MCP service layer has direct unit tests.
coverage:
	LC_ALL=C $(GO) test -count=1 -coverprofile=coverage.out ./...
	$(GO) tool cover -func=coverage.out | grep total:

clean:
	rm -rf $(BIN_DIR) coverage.out

license-add:
	@bash scripts/add-license.sh

license-check:
	@bash scripts/verify-license.sh

english-check:
	@$(GO) run scripts/verify-english-only.go
