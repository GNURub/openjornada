package saasaccess

import "github.com/pocketbase/pocketbase/core"

// Operational reports whether non-interactive clients may read or mutate
// tenant data. Terminals and MCP tokens are disabled in read-only mode because
// those protocols contain mutation capabilities and cannot safely degrade to
// an export-only experience.
func Operational(organization *core.Record) bool {
	if organization == nil {
		return false
	}
	switch organization.GetString("accessStatus") {
	case "", "active", "trialing", "grace":
		return true
	default:
		return false
	}
}
