// probe — 验证 utls Chrome 指纹能否通过 zcode.z.ai 的 ESA 边缘
package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"
)

const host = "zcode.z.ai"

func zcodeSecret() string {
	home, _ := os.UserHomeDir()
	platform := "linux"
	switch runtime.GOOS {
	case "windows":
		platform = "win32"
	case "darwin":
		platform = "darwin"
	}
	user := os.Getenv("USERNAME")
	if user == "" {
		user = "unknown"
	}
	return fmt.Sprintf("zcode-credential-fallback:%s:%s:%s", platform, home, user)
}

func decryptZCode(v, secret string) (string, error) {
	const prefix = "enc:v1:"
	if !strings.HasPrefix(v, prefix) {
		return v, nil
	}
	parts := strings.Split(strings.TrimPrefix(v, prefix), ".")
	if len(parts) != 3 {
		return "", fmt.Errorf("bad format")
	}
	sum := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	iv, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || len(iv) != 12 {
		return "", fmt.Errorf("bad iv")
	}
	tag, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(tag) != 16 {
		return "", fmt.Errorf("bad tag")
	}
	ct, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", err
	}
	full := append(append([]byte{}, ct...), tag...)
	pt, err := gcm.Open(nil, iv, full, nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

func loadZJWT() (string, error) {
	home, _ := os.UserHomeDir()
	raw, err := os.ReadFile(filepath.Join(home, ".zcode", "v2", "credentials.json"))
	if err != nil {
		return "", err
	}
	var store map[string]string
	if err := json.Unmarshal(raw, &store); err != nil {
		return "", err
	}
	return decryptZCode(store["zcodejwttoken"], zcodeSecret())
}

func dialChrome(ctx context.Context, nextProtos []string) (net.Conn, string, error) {
	raw, err := (&net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, "tcp", host+":443")
	if err != nil {
		return nil, "", err
	}
	uc := utls.UClient(raw, &utls.Config{ServerName: host, NextProtos: nextProtos}, utls.HelloChrome_120)
	if err := uc.HandshakeContext(ctx); err != nil {
		raw.Close()
		return nil, "", err
	}
	return uc, uc.ConnectionState().NegotiatedProtocol, nil
}

func setHeaders(req *http.Request, zjwt string) {
	req.Header.Set("authorization", "Bearer "+zjwt)
	req.Header.Set("content-type", "application/json")
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("user-agent", "ZCode/5.9.3")
	req.Header.Set("x-zcode-app-version", "5.9.3")
	req.Header.Set("referer", "https://zcode.z.ai")
	req.Header.Set("x-title", "Z Code@electron")
	req.Header.Set("x-platform", "win32-x64")
	req.Header.Set("x-os-category", "windows")
	req.Header.Set("x-os-version", "10.0.26300")
	req.Header.Set("x-client-language", "zh-CN")
	req.Header.Set("x-client-timezone", "Asia/Shanghai")
	req.Header.Set("x-device-mid", "0c5f8e58-4f22-45c3-a8dc-a507071cf840")
	req.Header.Set("accept", "application/json, text/plain, */*")
}

const messagesPath = "/api/v1/zcode-plan/anthropic/v1/messages"

func main() {
	zjwt, err := loadZJWT()
	if err != nil {
		fmt.Println("[token] ERROR", err)
		os.Exit(1)
	}
	fmt.Println("[token] zcodejwttoken loaded, len =", len(zjwt))

	body := `{"model":"glm-5.3-flash","max_tokens":16,"messages":[{"role":"user","content":"只回两个字：收到"}],"stream":false}`

	// ---- 尝试 1: Chrome 指纹 + h2 ----
	{
		tr := &http2.Transport{
			DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
				conn, alpn, err := dialChrome(ctx, []string{"h2", "http/1.1"})
				if err != nil {
					return nil, err
				}
				fmt.Println("[h2] ALPN negotiated:", alpn)
				return conn, nil
			},
		}
		req, _ := http.NewRequest("POST", "https://"+host+messagesPath, strings.NewReader(body))
		setHeaders(req, zjwt)
		resp, err := tr.RoundTrip(req)
		report("h2", resp, err)
	}

	// ---- 尝试 2: Chrome 指纹 + http/1.1 ----
	{
		conn, alpn, err := dialChrome(context.Background(), []string{"http/1.1"})
		if err != nil {
			fmt.Println("[h1] dial ERROR", err)
			return
		}
		fmt.Println("[h1] ALPN negotiated:", alpn)
		client := &http.Client{
			Transport: &http.Transport{
				DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) { return conn, nil },
			},
			Timeout: 45 * time.Second,
		}
		req, _ := http.NewRequest("POST", "https://"+host+messagesPath, strings.NewReader(body))
		setHeaders(req, zjwt)
		resp, err := client.Do(req)
		report("h1", resp, err)
	}
}

func report(label string, resp *http.Response, err error) {
	if err != nil {
		fmt.Printf("[%s] ERROR %v\n", label, err)
		return
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 400))
	fmt.Printf("[%s] HTTP %d server=%s\n", label, resp.StatusCode, resp.Header.Get("Server"))
	fmt.Printf("[%s] body: %s\n", label, strings.TrimSpace(string(b)))
}
