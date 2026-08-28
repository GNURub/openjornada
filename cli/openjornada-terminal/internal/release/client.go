package release

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	manifestAssetName       = "openjornada-m5stack-manifest.json"
	signatureAssetName      = "openjornada-m5stack-manifest.sig"
	githubReleaseURL        = "https://api.github.com/repos/GNURub/openjornada/releases/latest"
	releaseMetadataMaxBytes = 512 * 1024
	requestTimeout          = 30 * time.Second
)

var (
	ErrNetwork    = errors.New("release: network failure")
	ErrHTTPStatus = errors.New("release: unexpected HTTP status")
	ErrTooLarge   = errors.New("release: download too large")
	ErrRelease    = errors.New("release: invalid stable release")
	ErrAsset      = errors.New("release: required asset unavailable")
	ErrURLPolicy  = errors.New("release: URL rejected by policy")
	ErrTemporary  = errors.New("release: temporary file failure")
)

var productionAllowedHosts = map[string]struct{}{
	"api.github.com":                        {},
	"github.com":                            {},
	"objects.githubusercontent.com":         {},
	"github-releases.githubusercontent.com": {},
	"release-assets.githubusercontent.com":  {},
}

type Client struct {
	httpClient   *http.Client
	releaseURL   *url.URL
	allowedHosts map[string]struct{}
	tempDir      string
	timeout      time.Duration
}

type githubRelease struct {
	TagName    string        `json:"tag_name"`
	Draft      bool          `json:"draft"`
	Prerelease bool          `json:"prerelease"`
	Assets     []githubAsset `json:"assets"`
}

type githubAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

var defaultClient = mustDefaultClient()

func mustDefaultClient() *Client {
	client, err := newClient(http.DefaultClient, githubReleaseURL, productionAllowedHosts, "", requestTimeout)
	if err != nil {
		panic("invalid built-in GitHub release configuration")
	}
	return client
}

func newClient(base *http.Client, releaseURL string, allowedHosts map[string]struct{}, tempDir string, timeout time.Duration) (*Client, error) {
	hosts := make(map[string]struct{}, len(allowedHosts))
	for host := range allowedHosts {
		hosts[strings.ToLower(host)] = struct{}{}
	}
	parsed, err := url.Parse(releaseURL)
	if err != nil || timeout <= 0 || len(hosts) == 0 || !urlAllowed(parsed, hosts) {
		return nil, ErrURLPolicy
	}
	if base == nil {
		base = http.DefaultClient
	}
	clone := *base
	originalRedirect := clone.CheckRedirect
	clone.Timeout = timeout
	clone.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if len(via) >= 10 || !urlAllowed(request.URL, hosts) {
			return ErrURLPolicy
		}
		if originalRedirect != nil {
			return originalRedirect(request, via)
		}
		return nil
	}
	return &Client{httpClient: &clone, releaseURL: parsed, allowedHosts: hosts, tempDir: tempDir, timeout: timeout}, nil
}

func LatestStable(ctx context.Context) (Bundle, error) { return defaultClient.LatestStable(ctx) }

func (client *Client) LatestStable(ctx context.Context) (Bundle, error) {
	if ctx == nil {
		return Bundle{}, ErrNetwork
	}
	requestContext, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()

	metadata, err := client.downloadSmall(requestContext, client.releaseURL.String(), releaseMetadataMaxBytes)
	if err != nil {
		return Bundle{}, err
	}
	var discovered githubRelease
	if err := json.Unmarshal(metadata, &discovered); err != nil || discovered.Draft || discovered.Prerelease || !validReleaseTag(discovered.TagName) {
		return Bundle{}, ErrRelease
	}
	assets, err := requiredAssets(discovered.Assets)
	if err != nil {
		return Bundle{}, err
	}
	manifestBytes, err := client.downloadSmall(requestContext, assets[manifestAssetName], manifestMaxBytes)
	if err != nil {
		return Bundle{}, err
	}
	signatureBytes, err := client.downloadSmall(requestContext, assets[signatureAssetName], signatureMaxBytes)
	if err != nil {
		return Bundle{}, err
	}
	path, size, digest, err := client.downloadBinary(requestContext, assets[firmwareAssetName])
	if err != nil {
		return Bundle{}, err
	}
	return Bundle{
		ReleaseTag: discovered.TagName, Manifest: manifestBytes, Signature: signatureBytes,
		Path: path, Size: size, SHA256: digest, owner: newTemporaryOwner(path),
	}, nil
}

func requiredAssets(input []githubAsset) (map[string]string, error) {
	required := map[string]string{manifestAssetName: "", signatureAssetName: "", firmwareAssetName: ""}
	for _, asset := range input {
		if _, ok := required[asset.Name]; !ok {
			continue
		}
		if required[asset.Name] != "" || asset.BrowserDownloadURL == "" {
			return nil, ErrAsset
		}
		required[asset.Name] = asset.BrowserDownloadURL
	}
	for _, assetURL := range required {
		if assetURL == "" {
			return nil, ErrAsset
		}
	}
	return required, nil
}

func (client *Client) downloadSmall(ctx context.Context, source string, maximum int64) ([]byte, error) {
	response, err := client.get(ctx, source)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.ContentLength > maximum {
		return nil, ErrTooLarge
	}
	contents, err := io.ReadAll(io.LimitReader(response.Body, maximum+1))
	if err != nil {
		return nil, ErrNetwork
	}
	if int64(len(contents)) > maximum {
		return nil, ErrTooLarge
	}
	return contents, nil
}

func (client *Client) downloadBinary(ctx context.Context, source string) (path string, size int64, digest [32]byte, resultErr error) {
	response, err := client.get(ctx, source)
	if err != nil {
		return "", 0, digest, err
	}
	defer response.Body.Close()
	if response.ContentLength > otaSlotBytes {
		return "", 0, digest, ErrTooLarge
	}
	file, err := os.CreateTemp(client.tempDir, "openjornada-firmware-*.bin")
	if err != nil {
		return "", 0, digest, ErrTemporary
	}
	temporaryPath := file.Name()
	path = temporaryPath
	remove := true
	defer func() {
		if closeErr := file.Close(); closeErr != nil && resultErr == nil {
			resultErr = ErrTemporary
		}
		if resultErr != nil || remove {
			_ = os.Remove(temporaryPath)
			path = ""
		}
	}()
	if err := file.Chmod(0o600); err != nil {
		return "", 0, digest, ErrTemporary
	}
	hasher := sha256.New()
	size, err = io.Copy(io.MultiWriter(file, hasher), io.LimitReader(response.Body, otaSlotBytes+1))
	if err != nil {
		return "", 0, digest, ErrNetwork
	}
	if size > otaSlotBytes {
		return "", 0, digest, ErrTooLarge
	}
	copy(digest[:], hasher.Sum(nil))
	remove = false
	return path, size, digest, nil
}

func (client *Client) get(ctx context.Context, source string) (*http.Response, error) {
	parsed, err := url.Parse(source)
	if err != nil || !urlAllowed(parsed, client.allowedHosts) {
		return nil, ErrURLPolicy
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, ErrURLPolicy
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "openjornada-terminal")
	response, err := client.httpClient.Do(request)
	if err != nil {
		if errors.Is(err, ErrURLPolicy) {
			return nil, ErrURLPolicy
		}
		return nil, ErrNetwork
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		response.Body.Close()
		return nil, ErrHTTPStatus
	}
	return response, nil
}

func urlAllowed(candidate *url.URL, allowedHosts map[string]struct{}) bool {
	if candidate == nil || candidate.Scheme != "https" || candidate.Host == "" || candidate.User != nil || candidate.Opaque != "" || candidate.Fragment != "" {
		return false
	}
	_, ok := allowedHosts[strings.ToLower(candidate.Hostname())]
	return ok
}
