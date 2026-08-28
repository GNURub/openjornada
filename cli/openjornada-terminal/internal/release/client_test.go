package release

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func TestLatestStableDownloadsBoundedAssetsToPrivateTemporaryFile(t *testing.T) {
	firmware := []byte("streamed firmware")
	server := newReleaseServer(t, releaseFixture{firmware: firmware, redirectBinary: true})
	client := testReleaseClient(t, server, time.Second)

	bundle, err := client.LatestStable(context.Background())
	if err != nil {
		t.Fatalf("LatestStable() error = %v", err)
	}
	path := bundle.Path
	defer bundle.Close()
	if bundle.ReleaseTag != "v1.2.3" || !bytes.Equal(bundle.Manifest, []byte("manifest\n")) || !bytes.Equal(bundle.Signature, []byte("signature\n")) {
		t.Fatalf("bundle metadata = %+v", bundle)
	}
	if bundle.Size != int64(len(firmware)) {
		t.Fatalf("bundle size = %d", bundle.Size)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("temporary mode = %o", info.Mode().Perm())
	}
	if err := bundle.Close(); err != nil {
		t.Fatalf("Bundle.Close() error = %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("temporary firmware still exists: %v", err)
	}
}

func TestLatestStableRejectsUnsafeOrUnstableDiscovery(t *testing.T) {
	tests := []struct {
		name    string
		fixture releaseFixture
		want    error
	}{
		{name: "non-2xx", fixture: releaseFixture{status: http.StatusBadGateway, body: "private-response-marker"}, want: ErrHTTPStatus},
		{name: "prerelease flag", fixture: releaseFixture{prerelease: true}, want: ErrRelease},
		{name: "draft", fixture: releaseFixture{draft: true}, want: ErrRelease},
		{name: "prerelease semver", fixture: releaseFixture{tag: "v1.2.3-rc.1"}, want: ErrRelease},
		{name: "malformed semver", fixture: releaseFixture{tag: "release-1"}, want: ErrRelease},
		{name: "hostile redirect", fixture: releaseFixture{hostileRedirect: true}, want: ErrURLPolicy},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := newReleaseServer(t, test.fixture)
			client := testReleaseClient(t, server, time.Second)
			_, err := client.LatestStable(context.Background())
			if !errors.Is(err, test.want) {
				t.Fatalf("LatestStable() error = %v, want %v", err, test.want)
			}
			if err != nil && test.fixture.body != "" && strings.Contains(err.Error(), test.fixture.body) {
				t.Fatal("error leaked response body")
			}
		})
	}
}

func TestLatestStableRejectsTimeout(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		<-request.Context().Done()
	}))
	defer server.Close()
	client := testReleaseClient(t, server, 20*time.Millisecond)
	if _, err := client.LatestStable(context.Background()); !errors.Is(err, ErrNetwork) {
		t.Fatalf("LatestStable() timeout error = %v", err)
	}
}

func TestLatestStableRejectsEveryOversizedAssetAndCleansBinary(t *testing.T) {
	tests := []struct {
		name    string
		fixture releaseFixture
	}{
		{name: "manifest", fixture: releaseFixture{manifest: bytes.Repeat([]byte{'m'}, manifestMaxBytes+1)}},
		{name: "signature", fixture: releaseFixture{signature: bytes.Repeat([]byte{'s'}, signatureMaxBytes+1)}},
		{name: "binary", fixture: releaseFixture{firmware: bytes.Repeat([]byte{'f'}, otaSlotBytes+1)}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tempDir := t.TempDir()
			server := newReleaseServer(t, test.fixture)
			client := testReleaseClientInDir(t, server, time.Second, tempDir)
			if _, err := client.LatestStable(context.Background()); !errors.Is(err, ErrTooLarge) {
				t.Fatalf("LatestStable() error = %v", err)
			}
			entries, err := os.ReadDir(tempDir)
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 0 {
				t.Fatalf("temporary files remain: %v", entries)
			}
		})
	}
}

func TestLatestStableRequiresHTTPSEvenWhenHostIsAllowed(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()
	parsed, _ := url.Parse(server.URL)
	client, err := newClient(server.Client(), server.URL, map[string]struct{}{parsed.Hostname(): {}}, t.TempDir(), time.Second)
	if err == nil || client != nil || !errors.Is(err, ErrURLPolicy) {
		t.Fatalf("newClient() = (%v, %v)", client, err)
	}
}

type releaseFixture struct {
	status          int
	body            string
	tag             string
	draft           bool
	prerelease      bool
	manifest        []byte
	signature       []byte
	firmware        []byte
	redirectBinary  bool
	hostileRedirect bool
}

func newReleaseServer(t *testing.T, fixture releaseFixture) *httptest.Server {
	t.Helper()
	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/release":
			if fixture.status != 0 {
				response.WriteHeader(fixture.status)
				_, _ = response.Write([]byte(fixture.body))
				return
			}
			tag := fixture.tag
			if tag == "" {
				tag = "v1.2.3"
			}
			assets := []map[string]string{
				{"name": manifestAssetName, "browser_download_url": server.URL + "/manifest"},
				{"name": signatureAssetName, "browser_download_url": server.URL + "/signature"},
				{"name": firmwareAssetName, "browser_download_url": server.URL + "/firmware"},
			}
			if fixture.hostileRedirect {
				assets[0]["browser_download_url"] = server.URL + "/hostile"
			}
			_ = json.NewEncoder(response).Encode(map[string]any{"tag_name": tag, "draft": fixture.draft, "prerelease": fixture.prerelease, "assets": assets})
		case "/manifest":
			value := fixture.manifest
			if value == nil {
				value = []byte("manifest\n")
			}
			_, _ = response.Write(value)
		case "/signature":
			value := fixture.signature
			if value == nil {
				value = []byte("signature\n")
			}
			_, _ = response.Write(value)
		case "/firmware":
			if fixture.redirectBinary {
				http.Redirect(response, request, server.URL+"/firmware-final", http.StatusFound)
				return
			}
			value := fixture.firmware
			if value == nil {
				value = []byte("firmware")
			}
			_, _ = response.Write(value)
		case "/firmware-final":
			_, _ = response.Write(fixture.firmware)
		case "/hostile":
			http.Redirect(response, request, "https://hostile.invalid/private-response-marker", http.StatusFound)
		default:
			http.NotFound(response, request)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func testReleaseClient(t *testing.T, server *httptest.Server, timeout time.Duration) *Client {
	return testReleaseClientInDir(t, server, timeout, t.TempDir())
}

func testReleaseClientInDir(t *testing.T, server *httptest.Server, timeout time.Duration, tempDir string) *Client {
	t.Helper()
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := newClient(server.Client(), server.URL+"/release", map[string]struct{}{parsed.Hostname(): {}}, tempDir, timeout)
	if err != nil {
		t.Fatalf("newClient() error = %v", err)
	}
	return client
}
