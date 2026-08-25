package saasaccess

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

func TestOperational(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		status string
		want   bool
	}{
		{status: "", want: true},
		{status: "trialing", want: true},
		{status: "active", want: true},
		{status: "grace", want: true},
		{status: "read_only", want: false},
		{status: "suspended", want: false},
	} {
		t.Run(test.status, func(t *testing.T) {
			record := core.NewRecord(&core.Collection{})
			record.SetRaw("accessStatus", test.status)
			if got := Operational(record); got != test.want {
				t.Fatalf("Operational(%q) = %v, want %v", test.status, got, test.want)
			}
		})
	}
}
