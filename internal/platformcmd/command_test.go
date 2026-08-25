package platformcmd

import "testing"

func TestValidateCreateOptions(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		options createOptions
		wantErr bool
	}{
		{name: "admin válido", options: createOptions{email: "admin@example.com", name: "Administración", role: "admin"}},
		{name: "soporte válido", options: createOptions{email: "support@example.com", name: "Soporte", role: "support"}},
		{name: "correo inválido", options: createOptions{email: "no-es-correo", name: "Soporte", role: "support"}, wantErr: true},
		{name: "rol inválido", options: createOptions{email: "admin@example.com", name: "Administración", role: "owner"}, wantErr: true},
		{name: "nombre vacío", options: createOptions{email: "admin@example.com", role: "admin"}, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := validateCreateOptions(test.options)
			if (err != nil) != test.wantErr {
				t.Fatalf("validateCreateOptions() error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}
