package app

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/protocol"
	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/release"
	firmwareupdate "github.com/GNURub/openjornada/cli/openjornada-terminal/internal/update"
)

type fakeFirmwareClient struct{ *fakeDeviceClient }

func (client *fakeFirmwareClient) WriteBinary(context.Context, []byte) error { return nil }
func (client *fakeFirmwareClient) SetBaud(int) error                         { return nil }

func firmwareDependencies(client *fakeFirmwareClient, stdout *bytes.Buffer) Dependencies {
	return Dependencies{
		Stdout: stdout, Stderr: &bytes.Buffer{},
		Connect: func(context.Context, string) (DeviceClient, error) { return client, nil },
		LatestStable: func(context.Context) (release.Bundle, error) {
			return release.Bundle{ReleaseTag: "v2.0.0"}, nil
		},
		VerifyFirmware: func(release.Bundle, release.DeviceInfo) (release.VerifiedFirmware, error) {
			return release.VerifiedFirmware{Path: "temporary", Size: 12, Version: "2.0.0", Official: true}, nil
		},
		InspectCustom: func(string) (release.VerifiedFirmware, error) {
			return release.VerifiedFirmware{Path: "custom", Size: 12, Version: "2.0.0", Official: false}, nil
		},
	}
}

func executeFirmware(t *testing.T, deps Dependencies, args ...string) error {
	t.Helper()
	command := NewRoot(deps)
	command.SetArgs(args)
	return command.Execute()
}

func readyFirmwareClient(version string) *fakeFirmwareClient {
	replies := healthyReplies("ready")
	hello := replies["hello"].data.(protocol.Hello)
	hello.FirmwareVersion = version
	hello.Capabilities.FirmwareInstall = true
	hello.Capabilities.NegotiatedBaud = true
	replies["hello"] = fakeReply{data: hello}
	status := replies["status"].data.(deviceStatus)
	status.FirmwareVersion = version
	status.PendingCount = 0
	replies["status"] = fakeReply{data: status}
	return &fakeFirmwareClient{&fakeDeviceClient{replies: replies, events: make(chan protocol.Event, 8)}}
}

func TestFirmwareCheckNeverStartsTransfer(t *testing.T) {
	client := readyFirmwareClient("1.5.0")
	stdout := &bytes.Buffer{}
	deps := firmwareDependencies(client, stdout)
	transfers := 0
	deps.TransferFirmware = func(context.Context, firmwareupdate.Client, release.VerifiedFirmware, firmwareupdate.ProgressFunc) error {
		transfers++
		return nil
	}
	if err := executeFirmware(t, deps, "firmware", "check"); err != nil {
		t.Fatal(err)
	}
	if transfers != 0 || strings.Contains(strings.Join(client.commands, ","), "firmware_begin") {
		t.Fatalf("check transferred firmware: transfers=%d commands=%v", transfers, client.commands)
	}
	if !strings.Contains(stdout.String(), "2.0.0") || !strings.Contains(stdout.String(), "1.5.0") {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestFirmwareCheckDoesNotRequireTransferCapabilities(t *testing.T) {
	client := readyFirmwareClient("1.5.0")
	hello := client.replies["hello"].data.(protocol.Hello)
	hello.Capabilities.FirmwareInstall = false
	hello.Capabilities.NegotiatedBaud = false
	client.replies["hello"] = fakeReply{data: hello}
	if err := executeFirmware(t, firmwareDependencies(client, &bytes.Buffer{}), "firmware", "check"); err != nil {
		t.Fatal(err)
	}
}

func TestFirmwareUpdateRefusesSameVersionAndDowngrade(t *testing.T) {
	for _, latest := range []string{"1.5.0", "1.4.9"} {
		t.Run(latest, func(t *testing.T) {
			client := readyFirmwareClient("1.5.0")
			deps := firmwareDependencies(client, &bytes.Buffer{})
			deps.VerifyFirmware = func(release.Bundle, release.DeviceInfo) (release.VerifiedFirmware, error) {
				return release.VerifiedFirmware{Path: "temporary", Size: 12, Version: latest, Official: true}, nil
			}
			called := false
			deps.TransferFirmware = func(context.Context, firmwareupdate.Client, release.VerifiedFirmware, firmwareupdate.ProgressFunc) error {
				called = true
				return nil
			}
			err := executeFirmware(t, deps, "firmware", "update")
			if err == nil || called {
				t.Fatalf("latest=%s error=%v called=%v", latest, err, called)
			}
		})
	}
}

func TestFirmwareUpdateTransfersOnlyVerifiedNewerOfficialImage(t *testing.T) {
	client := readyFirmwareClient("1.5.0")
	stdout := &bytes.Buffer{}
	deps := firmwareDependencies(client, stdout)
	called := false
	deps.TransferFirmware = func(_ context.Context, gotClient firmwareupdate.Client, firmware release.VerifiedFirmware, progress firmwareupdate.ProgressFunc) error {
		called = gotClient == client && firmware.Official && firmware.Version == "2.0.0"
		progress(firmware.Size, firmware.Size)
		return nil
	}
	if err := executeFirmware(t, deps, "firmware", "update"); err != nil {
		t.Fatal(err)
	}
	if !called || !strings.Contains(stdout.String(), "100%") {
		t.Fatalf("called=%v stdout=%q", called, stdout.String())
	}
}

func TestFirmwareInstallWarnsBeforeTransferAndDoesNotPrintFilename(t *testing.T) {
	client := readyFirmwareClient("1.5.0")
	stdout := &bytes.Buffer{}
	deps := firmwareDependencies(client, stdout)
	secretPath := filepath.Join(t.TempDir(), "nombre-privado.bin")
	if err := os.WriteFile(secretPath, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	deps.TransferFirmware = func(context.Context, firmwareupdate.Client, release.VerifiedFirmware, firmwareupdate.ProgressFunc) error {
		if !strings.Contains(stdout.String(), "personalizado") || !strings.Contains(stdout.String(), "SOLO C") {
			t.Fatal("warning was not printed before transfer")
		}
		return nil
	}
	if err := executeFirmware(t, deps, "firmware", "install", secretPath); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stdout.String(), secretPath) || strings.Contains(stdout.String(), filepath.Base(secretPath)) {
		t.Fatalf("stdout exposed filename: %q", stdout.String())
	}
}

func TestFirmwareInstallRedactsInspectionFailure(t *testing.T) {
	client := readyFirmwareClient("1.5.0")
	stdout := &bytes.Buffer{}
	deps := firmwareDependencies(client, stdout)
	deps.InspectCustom = func(string) (release.VerifiedFirmware, error) {
		return release.VerifiedFirmware{}, errors.New("secret-firmware-name.bin")
	}
	err := executeFirmware(t, deps, "firmware", "install", "secret-firmware-name.bin")
	if err == nil || strings.Contains(err.Error(), "secret-firmware-name.bin") || strings.Contains(stdout.String(), "secret-firmware-name.bin") {
		t.Fatalf("stdout=%q error=%v", stdout.String(), err)
	}
}
